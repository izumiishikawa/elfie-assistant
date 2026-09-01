#!/usr/bin/env python3

import io
import json
import os
import queue
import select
import signal
import socket
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import time
import wave
from pathlib import Path

import numpy as np
import requests

try:
    from evdev import InputDevice, ecodes, list_devices
    EVDEV_OK = True
except ImportError:
    EVDEV_OK = False

try:
    import webrtcvad
    WEBRTCVAD_OK = True
except ImportError:
    WEBRTCVAD_OK = False

CONFIG_PATH = Path.home() / '.config' / 'elfie' / 'daemon.json'
SOCK_PATH   = '/tmp/elfie.sock'
PID_PATH    = '/tmp/elfie.pid'


def _ensure_single_instance():
    if not os.path.exists(PID_PATH):
        return
    try:
        old_pid = int(Path(PID_PATH).read_text().strip())
    except (OSError, ValueError):
        return
    if old_pid == os.getpid():
        return
    try:
        os.kill(old_pid, 0)
    except OSError:
        return

    print(f'[elfie] encerrando instância anterior (pid {old_pid})...', flush=True)
    try:
        os.kill(old_pid, signal.SIGTERM)
    except OSError:
        return
    for _ in range(50):
        time.sleep(0.1)
        try:
            os.kill(old_pid, 0)
        except OSError:
            return
    print(f'[elfie] instância anterior (pid {old_pid}) não respondeu, forçando...', flush=True)
    try:
        os.kill(old_pid, signal.SIGKILL)
    except OSError:
        pass

SAMPLE_RATE   = 16000
BLOCK_SIZE    = 480
CALIB_FRAMES  = 60
START_MULT    = 2.2;  START_MIN  = 0.045
STOP_MULT     = 1.4;  STOP_MIN   = 0.03
START_HOLD_MS = 200
SILENCE_MS    = 700
MIN_DUR_MS    = 700;  MIN_BYTES  = 4000
PRE_ROLL_MS   = 300

VAD_AGGRESSIVENESS = 2

_FFT_N  = BLOCK_SIZE * 2
_BIN_HZ = SAMPLE_RATE / _FFT_N
_LO_BIN = max(1, int(300  / _BIN_HZ))
_HI_BIN =        int(3400 / _BIN_HZ)


def _speech_energy(block: np.ndarray) -> float:
    spec = np.abs(np.fft.rfft(block, n=_FFT_N))
    return float(spec[_LO_BIN:_HI_BIN + 1].mean())


def _encode_wav(frames: list) -> bytes:
    pcm = np.concatenate(frames)
    buf = io.BytesIO()
    with wave.open(buf, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes((np.clip(pcm, -1.0, 1.0) * 32767).astype(np.int16).tobytes())
    return buf.getvalue()


STATES = {
    'muted':        'mudo',
    'calibrating':  'calibrando...',
    'listening':    'ouvindo...',
    'recording':    'gravando...',
    'transcribing': 'transcrevendo...',
    'processing':   'pensando...',
    'speaking':     'falando...',
}

NEURO_TOOL_LABELS = {
    'bash': 'executando no terminal',
    'computer': 'controlando o computador',
    'write_file': 'escrevendo arquivo',
    'read_file': 'lendo arquivo',
    'list_directory': 'explorando diretório',
    'search_files': 'procurando arquivos',
    'edit_file': 'editando arquivo',
    'create_directory': 'criando diretório',
    'move_file': 'movendo arquivo',
    'delete_file': 'deletando arquivo',
}

NEURO_UPDATE_TEMPLATES = [
    'tô {label} agora...',
    '{label}...',
    'já tô {label}',
    'deixa eu {label} aqui...',
]


class ElfieDaemon:
    def __init__(self):
        CONFIG_PATH.parent.mkdir(parents=True, exist_ok=True)
        self.cfg = self._load_cfg()

        self._state     = 'calibrating'
        self._muted     = True
        self._stop      = threading.Event()
        self._busy      = threading.Event()
        self._play_lock = threading.Lock()
        self._play_proc = None
        self._session   = requests.Session()

        self._blk_q = queue.Queue(maxsize=300)
        self._rec_q = queue.Queue()
        self._aud_q = queue.Queue()

        self._energy    = 0.0
        self._start_thr = START_MIN

        self._active_overlay_proc: subprocess.Popen | None = None
        self._tool_overlay_only = False
        self._mind_overlay_proc: subprocess.Popen | None = None

        self._draining       = threading.Event()
        self._loading_proc:  subprocess.Popen | None = None
        self._loading_lock   = threading.Lock()

        self._neuro_sessions: dict = {}
        self._sessions_lock  = threading.Lock()

    def _load_cfg(self) -> dict:
        if CONFIG_PATH.exists():
            try:
                return json.loads(CONFIG_PATH.read_text())
            except Exception:
                pass
        cfg = {'apiBase': 'http://localhost:3000', 'chatId': ''}
        CONFIG_PATH.write_text(json.dumps(cfg, indent=2))
        return cfg

    def _resolve_stt_provider(self, api: str) -> str:
        override = self.cfg.get('sttProviderOverride')
        if override:
            return override
        try:
            r = self._session.get(f'{api}/api/settings', timeout=5)
            r.raise_for_status()
            return r.json().get('sttProvider') or 'elevenlabs'
        except Exception:
            return 'elevenlabs'

    def _save_cfg(self):
        CONFIG_PATH.write_text(json.dumps(self.cfg, indent=2))

    def _vu_bar(self) -> str:
        if self._start_thr <= 0:
            return ''
        ratio = min(1.0, self._energy / self._start_thr)
        filled = int(ratio * 8)
        return f' [{"█" * filled}{"░" * (8 - filled)}]'

    _OVERLAY_ENERGY_IDLE_STATES = {'transcribing', 'processing', 'speaking'}

    def _set_state(self, s: str):
        prev = self._state
        self._state = s
        self._redraw()

        if s == 'processing':
            self._start_loading_sound()
        else:
            self._stop_loading_sound()

        if self._muted or s == 'calibrating':
            self._close_active_overlay()
        else:
            self._ensure_active_overlay()
            if s in self._OVERLAY_ENERGY_IDLE_STATES:
                self._send_energy_to_overlay(0.0)
            self._send_state_to_overlay(s)

    def _redraw(self):
        mute  = ' [MUDO]' if self._muted else ''
        chat  = (self.cfg.get('chatId') or '—')[:20]
        label = STATES.get(self._state, self._state)
        vu    = self._vu_bar() if self._state in ('listening', 'recording') else ''
        print(f'\r[elfie] {label}{mute}{vu} | {chat}   ', end='', flush=True)

    def _spawn_active_overlay(self):
        try:
            script = Path(__file__).parent / 'elfie_overlay.py'
            if not script.exists():
                return

            proc = subprocess.Popen(
                [sys.executable, str(script), 'active'],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
            self._active_overlay_proc = proc
        except Exception:
            pass

    def _ensure_active_overlay(self):
        proc = self._active_overlay_proc
        if proc and proc.poll() is None:
            return
        threading.Thread(target=self._spawn_active_overlay, daemon=True).start()

    def _close_active_overlay(self):
        proc = self._active_overlay_proc
        if proc and proc.poll() is None:
            try:
                proc.stdin.write((json.dumps({'state': 'closing'}) + '\n').encode())
                proc.stdin.flush()
            except Exception:
                pass
            try:
                proc.stdin.close()
            except Exception:
                pass
        self._active_overlay_proc = None

    def _spawn_mind_overlay(self):
        old = self._mind_overlay_proc
        if old and old.poll() is None:
            self._close_mind_overlay()
            try:
                old.wait(timeout=1.0)
            except Exception:
                try:
                    old.kill()
                except Exception:
                    pass
        try:
            script = Path(__file__).parent / 'elfie_overlay.py'
            if not script.exists():
                return
            api = self.cfg.get('apiBase', 'http://localhost:3000')
            self._mind_overlay_proc = subprocess.Popen(
                [sys.executable, str(script), 'mind', api],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception:
            pass

    def _close_mind_overlay(self):
        proc = self._mind_overlay_proc
        if proc and proc.poll() is None:
            try:
                proc.stdin.write((json.dumps({'close': True}) + '\n').encode())
                proc.stdin.flush()
            except Exception:
                pass
            try:
                proc.stdin.close()
            except Exception:
                pass
        self._mind_overlay_proc = None

    def _send_energy_to_overlay(self, ratio: float):
        proc = self._active_overlay_proc
        if proc and proc.poll() is None:
            try:
                proc.stdin.write((json.dumps({'energy': ratio}) + '\n').encode())
                proc.stdin.flush()
            except Exception:
                self._active_overlay_proc = None

    def _send_state_to_overlay(self, state: str):
        proc = self._active_overlay_proc
        if proc and proc.poll() is None:
            try:
                proc.stdin.write((json.dumps({'state': state}) + '\n').encode())
                proc.stdin.flush()
            except Exception:
                self._active_overlay_proc = None

    def _send_subtitle_to_overlay(self, text: str):
        proc = self._active_overlay_proc
        if not proc or proc.poll() is not None:
            print(f'\n[subtitle] _send_subtitle_to_overlay({text!r}) SKIPPED — no live overlay '
                  f'process (proc={proc!r}, poll={proc.poll() if proc else None})', flush=True)
            return
        try:
            proc.stdin.write((json.dumps({'subtitle': text}) + '\n').encode())
            proc.stdin.flush()
            print(f'\n[subtitle] sent to overlay stdin: {text!r}', flush=True)
        except Exception as ex:
            print(f'\n[subtitle] _send_subtitle_to_overlay write FAILED: {ex}', flush=True)
            self._active_overlay_proc = None

    def _show_tool_activity(self, tool_name: str, detail: str = ''):
        proc = self._active_overlay_proc
        spawned_fresh = not proc or proc.poll() is not None
        if spawned_fresh:
            self._spawn_active_overlay()
            proc = self._active_overlay_proc
            self._tool_overlay_only = self._muted
        if proc:
            try:
                proc.stdin.write((json.dumps({'tool': tool_name, 'detail': detail}) + '\n').encode())
                proc.stdin.flush()
            except Exception:
                self._active_overlay_proc = None

    def _clear_tool_activity(self):
        proc = self._active_overlay_proc
        if proc and proc.poll() is None:
            try:
                proc.stdin.write((json.dumps({'tool': None}) + '\n').encode())
                proc.stdin.flush()
            except Exception:
                pass
        if self._tool_overlay_only and self._muted:
            self._close_active_overlay()
        self._tool_overlay_only = False

    def _toggle_mute(self):
        self._muted = not self._muted
        if self._muted:
            self._set_state('muted')
        else:
            self._set_state('listening')
        self._notify_avatar_state()

    def _notify_avatar_state(self):
        api = self.cfg.get('apiBase', 'http://localhost:3000')
        muted = self._muted
        def _post():
            try:
                requests.post(f'{api}/api/avatar/state', json={'muted': muted}, timeout=5)
            except Exception as ex:
                print(f'\n[elfie] avatar state notify error: {ex}', flush=True)
        threading.Thread(target=_post, daemon=True, name='avatar-state-notify').start()

    def _audio_capture_loop(self):
        cmd = [
            'ffmpeg', '-loglevel', 'quiet',
            '-f', 'pulse', '-i', 'default',
            '-ar', str(SAMPLE_RATE),
            '-ac', '1',
            '-f', 's16le',
            'pipe:1',
        ]
        bytes_per_block = BLOCK_SIZE * 2

        while not self._stop.is_set():
            try:
                proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
            except Exception as ex:
                print(f'\n[elfie] erro ao abrir microfone: {ex}', flush=True)
                time.sleep(3)
                continue

            try:
                while not self._stop.is_set():
                    raw = proc.stdout.read(bytes_per_block)
                    if len(raw) < bytes_per_block:
                        break
                    block = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
                    try:
                        self._blk_q.put_nowait(block)
                    except queue.Full:
                        pass
            finally:
                proc.terminate()
                try:
                    proc.wait(timeout=2)
                except Exception:
                    proc.kill()

            if not self._stop.is_set():
                time.sleep(1)

    def _vad_loop(self):
        calib: list = []
        start_thr = START_MIN
        stop_thr  = STOP_MIN
        
        vad_state     = 'idle'
        hold_start    = 0.0
        silence_start = 0.0

        pre_roll_frames = max(1, int((PRE_ROLL_MS / 1000.0) * SAMPLE_RATE / BLOCK_SIZE))
        ring_buffer: list = []

        rec_frames: list = []

        speech_vad = webrtcvad.Vad(VAD_AGGRESSIVENESS) if WEBRTCVAD_OK else None
        if not WEBRTCVAD_OK:
            print('\n[elfie] webrtcvad não instalado — detector de música/ruído desativado, '
                  'usando só energia (pip3 install --break-system-packages webrtcvad)', flush=True)

        def _is_speech(block: np.ndarray) -> bool:
            if speech_vad is None:
                return True
            pcm16 = np.clip(block * 32768.0, -32768, 32767).astype(np.int16).tobytes()
            try:
                return speech_vad.is_speech(pcm16, SAMPLE_RATE)
            except Exception:
                return True

        self._set_state('calibrating')

        while not self._stop.is_set():
            try:
                block = self._blk_q.get(timeout=0.1)
            except queue.Empty:
                continue

            if len(calib) < CALIB_FRAMES:
                calib.append(_speech_energy(block))
                if len(calib) == CALIB_FRAMES:
                    ambient   = sum(calib) / CALIB_FRAMES
                    start_thr = max(START_MIN, ambient * START_MULT)
                    stop_thr  = max(STOP_MIN,  ambient * STOP_MULT)
                    self._start_thr = start_thr
                    self._set_state('listening')
                continue

            if self._muted or self._busy.is_set():
                vad_state     = 'idle'
                hold_start    = 0.0
                silence_start = 0.0
                ring_buffer.clear()
                continue

            e   = _speech_energy(block)
            self._energy = e
            self._redraw()
            if self._start_thr > 0:
                self._send_energy_to_overlay(min(1.0, e / self._start_thr))
            now = time.monotonic()

            if vad_state == 'idle':
                ring_buffer.append(block)
                if len(ring_buffer) > pre_roll_frames:
                    ring_buffer.pop(0)

                if e > start_thr and _is_speech(block):
                    vad_state  = 'hold'
                    hold_start = now

            elif vad_state == 'hold':
                ring_buffer.append(block)
                if len(ring_buffer) > pre_roll_frames:
                    ring_buffer.pop(0)

                if e < start_thr or not _is_speech(block):
                    vad_state = 'idle'
                elif (now - hold_start) * 1000 >= START_HOLD_MS:
                    vad_state  = 'recording'
                    rec_frames = list(ring_buffer)
                    silence_start = 0.0
                    self._set_state('recording')

            elif vad_state == 'recording':
                rec_frames.append(block)
                
                if e < stop_thr:
                    if silence_start == 0.0:
                        silence_start = now
                    elif (now - silence_start) * 1000 >= SILENCE_MS:
                        vad_state     = 'idle'
                        silence_start = 0.0
                        
                        dur_ms = len(rec_frames) * (BLOCK_SIZE / SAMPLE_RATE) * 1000
                        wav    = _encode_wav(rec_frames)
                        
                        rec_frames = []
                        ring_buffer.clear()
                        
                        if dur_ms >= MIN_DUR_MS and len(wav) >= MIN_BYTES:
                            self._busy.set()
                            self._set_state('transcribing')
                            self._rec_q.put(wav)
                        else:
                            self._set_state('listening')
                else:
                    silence_start = 0.0

    def _transcribe_loop(self):
        while not self._stop.is_set():
            try:
                wav = self._rec_q.get(timeout=0.5)
            except queue.Empty:
                continue

            api  = self.cfg.get('apiBase', 'http://localhost:3000')
            prov = self._resolve_stt_provider(api)

            try:
                chat = self._check_chat_ready(api, self.cfg.get('chatId', ''))
            except Exception as ex:
                print(f'\n[elfie] erro ao verificar chat: {ex}', flush=True)
                self._busy.clear()
                self._set_state('listening')
                continue

            try:
                r = self._session.post(
                    f'{api}/api/transcribe',
                    files={'audio': ('audio.wav', wav, 'audio/wav')},
                    data={'provider': prov},
                    timeout=30,
                )
                r.raise_for_status()
                transcript = r.json().get('transcript', '').strip()
            except Exception as ex:
                print(f'\n[elfie] transcribe error: {ex}', flush=True)
                self._busy.clear()
                self._set_state('listening')
                continue

            if len(transcript) < 2:
                self._busy.clear()
                self._set_state('listening')
                continue

            self._set_state('processing')
            self._stream_voice(api, chat, transcript)

    def _create_new_chat(self, api: str) -> str:
        r = self._session.post(f'{api}/api/chats', timeout=10)
        r.raise_for_status()
        new_id = r.json()['_id']
        self.cfg['chatId'] = new_id
        self._save_cfg()
        print(f'\n[elfie] novo chat criado: {new_id}', flush=True)
        self._redraw()
        return new_id

    def _check_chat_ready(self, api: str, chat_id: str) -> str:
        if not chat_id:
            return self._create_new_chat(api)
        try:
            r = self._session.get(f'{api}/api/chats/{chat_id}', timeout=5)
            if r.status_code == 404:
                return self._create_new_chat(api)
            r.raise_for_status()
            data = r.json()
            msgs = data.get('messages', [])
            if len(msgs) > 40:
                return self._create_new_chat(api)
        except requests.HTTPError:
            raise
        except Exception:
            pass
        return chat_id

    def _process_voice_stream(self, r, api: str):
        buf = ''
        for chunk in r.iter_content(chunk_size=None, decode_unicode=True):
            if self._stop.is_set():
                break
            buf += chunk
            lines = buf.split('\n')
            buf   = lines.pop()
            for line in lines:
                if not line.startswith('data:'):
                    continue
                try:
                    ev = json.loads(line[5:].strip())
                except Exception:
                    continue
                ev_type = ev.get('type')
                if ev_type == 'neuro_started':
                    self._play_sfx('neuro.mp3')
                elif ev_type == 'tool_call' and ev.get('name'):
                    if ev['name'] == 'web_search':
                        self._play_sfx('websearch.mp3')
                    self._show_tool_activity(ev['name'], ev.get('detail') or '')
                elif ev_type == 'audio_chunk':
                    text = ev.get('text') or ''
                    print(f'\n[subtitle] audio_chunk received, text={text!r}', flush=True)
                    if ev.get('data'):
                        import base64
                        self._aud_q.put({'audio': base64.b64decode(ev['data']), 'text': text})
                    else:
                        self._aud_q.put({'audio': ev['filename'], 'text': text})
                    self._set_state('speaking')
                elif ev_type == 'neuro_confirm':
                    if ev.get('channel') != 'voice':
                        task_id = ev.get('taskId')
                        if task_id:
                            def _auto_confirm(tid=task_id, _api=api):
                                try:
                                    requests.post(
                                        f'{_api}/api/neuro/{tid}/confirm',
                                        timeout=10,
                                    )
                                except Exception as e:
                                    print(f'\n[neuro] auto-confirm error: {e}', flush=True)
                            threading.Thread(
                                target=_auto_confirm,
                                daemon=True,
                                name=f'neuro-autoconfirm-{task_id[:8]}',
                            ).start()

        self._clear_tool_activity()

    def _stream_voice(self, api: str, chat_id: str, text: str):
        try:
            with self._session.post(
                f'{api}/api/chats/{chat_id}/voice',
                json={'text': text},
                stream=True,
                timeout=60,
            ) as r:
                if r.status_code == 404:
                    chat_id = self._create_new_chat(api)
                    with self._session.post(
                        f'{api}/api/chats/{chat_id}/voice',
                        json={'text': text},
                        stream=True,
                        timeout=60,
                    ) as r2:
                        r2.raise_for_status()
                        self._process_voice_stream(r2, api)
                else:
                    r.raise_for_status()
                    self._process_voice_stream(r, api)
        except Exception as ex:
            print(f'\n[elfie] voice error: {ex}', flush=True)

        self._aud_q.put(None)

    def _playback_loop(self):
        while not self._stop.is_set():
            try:
                item = self._aud_q.get(timeout=0.5)
            except queue.Empty:
                continue

            if item is None:
                if self._draining.is_set():
                    self._draining.clear()
                elif self._aud_q.empty():
                    self._busy.clear()
                    self._set_state('listening')
                self._send_subtitle_to_overlay('')
                continue

            if self._draining.is_set():
                continue

            audio_ref = item['audio']
            text = item.get('text') or ''

            if isinstance(audio_ref, bytes):
                audio_data = audio_ref
            else:
                api = self.cfg.get('apiBase', 'http://localhost:3000')
                try:
                    r = self._session.get(f'{api}/files/{audio_ref}', timeout=15)
                    r.raise_for_status()
                    audio_data = r.content
                except Exception as ex:
                    print(f'\n[elfie] download error {audio_ref}: {ex}', flush=True)
                    continue

            with tempfile.NamedTemporaryFile(suffix='.mp3', delete=False) as f:
                f.write(audio_data)
                tmp_path = f.name

            if text:
                self._send_subtitle_to_overlay(text)

            try:
                proc = subprocess.Popen(
                    ['mpg123', '-q', '-f', '22938', tmp_path],
                )
                with self._play_lock:
                    self._play_proc = proc
                proc.wait()
            except Exception as ex:
                print(f'\n[elfie] playback error: {ex}', flush=True)
            finally:
                with self._play_lock:
                    self._play_proc = None
                try:
                    os.unlink(tmp_path)
                except OSError:
                    pass

    def _stop_playback(self):
        with self._play_lock:
            if self._play_proc and self._play_proc.poll() is None:
                self._play_proc.terminate()

    def _play_sfx(self, filename: str, volume: float = 1.0):
        path = Path(__file__).parent / filename
        if not path.exists():
            return
        scale = int(32768 * max(0.0, min(1.0, volume)))
        def _run():
            try:
                subprocess.Popen(
                    ['mpg123', '-q', '-f', str(scale), str(path)],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                ).wait()
            except Exception:
                pass
        threading.Thread(target=_run, daemon=True).start()

    def _start_loading_sound(self):
        path = Path(__file__).parent / 'loading.mp3'
        if not path.exists():
            return
        with self._loading_lock:
            if self._loading_proc and self._loading_proc.poll() is None:
                return
            try:
                self._loading_proc = subprocess.Popen(
                    ['mpg123', '-q', '--loop', '-1', '-f', '16384', str(path)],
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                )
            except Exception:
                pass

    def _stop_loading_sound(self):
        with self._loading_lock:
            if self._loading_proc and self._loading_proc.poll() is None:
                try:
                    self._loading_proc.terminate()
                except Exception:
                    pass
            self._loading_proc = None

    def _interrupt_response(self):
        self._draining.set()
        self._stop_playback()
        self._busy.clear()
        self._send_subtitle_to_overlay('')
        self._set_state('muted' if self._muted else 'listening')
        chat_id = self.cfg.get('chatId', '')
        if chat_id:
            with self._sessions_lock:
                session = self._neuro_sessions.get(chat_id)
            if session and session['proc'].poll() is None:
                try:
                    session['proc'].send_signal(signal.SIGINT)
                    session['discarding'] = True
                except Exception:
                    pass
        print('\n[elfie] resposta interrompida (F7)', flush=True)


    @staticmethod
    def _is_question(text: str) -> bool:
        lines = [l.strip() for l in text.strip().splitlines() if l.strip()]
        return bool(lines) and lines[-1].endswith('?')

    def _get_or_create_neuro_session(self, chat_id: str, elfie_system_prompt: str = '') -> dict:
        with self._sessions_lock:
            if chat_id in self._neuro_sessions:
                session = self._neuro_sessions[chat_id]
                if session['proc'].poll() is None:
                    return session
                del self._neuro_sessions[chat_id]

            session_dir = Path(f'/tmp/neuro-{chat_id}')
            session_dir.mkdir(parents=True, exist_ok=True)

            claude_md = session_dir / 'CLAUDE.md'
            if elfie_system_prompt and (not claude_md.exists() or claude_md.stat().st_size == 0):
                claude_md.write_text(elfie_system_prompt, encoding='utf-8')
                print(f'\n[neuro:{chat_id[:8]}] CLAUDE.md written ({len(elfie_system_prompt)} chars)', flush=True)
            else:
                print(f'\n[neuro:{chat_id[:8]}] CLAUDE.md reused from {session_dir}', flush=True)

            cmd = [
                'claude',
                '--dangerously-skip-permissions',
                '--verbose',
                '--output-format', 'stream-json',
                '--input-format', 'stream-json',
            ]

            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                cwd=str(session_dir),
            )

            session = {
                'chat_id': chat_id,
                'api_base': self.cfg.get('apiBase', 'http://localhost:3000'),
                'proc': proc,
                'lock': threading.Lock(),
                'discarding': False,
                'session_dir': str(session_dir),
            }
            self._neuro_sessions[chat_id] = session

            threading.Thread(
                target=self._neuro_session_reader,
                args=(session,),
                daemon=True,
                name=f'neuro-{chat_id[:8]}',
            ).start()

            threading.Thread(
                target=self._neuro_stderr_reader,
                args=(proc, chat_id[:8]),
                daemon=True,
                name=f'neuro-stderr-{chat_id[:8]}',
            ).start()

            print(f'\n[neuro:{chat_id[:8]}] new session started (PID: {proc.pid})', flush=True)
            return session

    def _neuro_stderr_reader(self, proc: subprocess.Popen, tid: str):
        try:
            for line in proc.stderr:
                line = line.rstrip()
                if line:
                    print(f'\n[neuro:{tid}] stderr: {line}', flush=True)
        except Exception:
            pass

    def _neuro_session_reader(self, session: dict):
        import random as _random
        chat_id  = session['chat_id']
        api_base = session['api_base']
        tid      = chat_id[:8]
        last_narration = 0.0
        NARRATION_INTERVAL = 20.0

        def log(msg: str):
            print(f'\n[neuro:{tid}] {msg}', flush=True)

        def post_event(event: dict):
            if session['discarding'] and event.get('type') not in (
                'neuro_done', 'neuro_interrupted', 'neuro_session_ended'
            ):
                return
            try:
                requests.post(
                    f'{api_base}/api/neuro/session/{chat_id}/event',
                    json=event,
                    timeout=5,
                )
            except Exception as e:
                log(f'post_event error: {e}')

        log('persistent reader started')

        try:
            for raw_line in session['proc'].stdout:
                raw_line = raw_line.strip()
                if not raw_line:
                    continue
                try:
                    ev = json.loads(raw_line)
                except Exception:
                    continue

                ev_type = ev.get('type', '')
                now     = time.monotonic()

                if ev_type == 'tool_use':
                    tool_name = ev.get('name', '')
                    label = NEURO_TOOL_LABELS.get(tool_name, tool_name.replace('_', ' '))
                    log(f'tool_use: {tool_name}')
                    post_event({'type': 'neuro_tool', 'tool': tool_name, 'label': label})
                    if now - last_narration >= NARRATION_INTERVAL:
                        last_narration = now
                        narration = _random.choice(NEURO_UPDATE_TEMPLATES).format(label=label)
                        post_event({'type': 'neuro_update', 'text': narration})

                elif ev_type == 'assistant':
                    content_blocks = ev.get('message', {}).get('content', [])
                    full_text = ''.join(
                        b.get('text', '') for b in content_blocks
                        if isinstance(b, dict) and b.get('type') == 'text'
                    ).strip()
                    if not full_text:
                        continue
                    if '%%DONE%%' in full_text:
                        full_text = full_text[:full_text.find('%%DONE%%')].strip()
                    if not full_text:
                        continue
                    log(f'assistant ({len(full_text)} chars)')
                    post_event({'type': 'neuro_text', 'text': full_text})
                    if self._is_question(full_text):
                        post_event({'type': 'neuro_question', 'text': full_text})

                elif ev_type == 'result':
                    result_text = ev.get('result', '').strip()
                    is_error    = ev.get('subtype') == 'error' or ev.get('is_error', False)
                    log(f'result (error={is_error}): "{result_text[:120]}"')
                    if session['discarding']:
                        session['discarding'] = False
                        self._play_sfx('neurooff.mp3')
                        post_event({'type': 'neuro_interrupted'})
                    elif '%%DONE%%' in result_text:
                        self._play_sfx('neurooff.mp3')
                        sentinel_idx = result_text.find('%%DONE%%')
                        clean_text = result_text[:sentinel_idx].strip()
                        sentinel_payload = result_text[sentinel_idx + len('%%DONE%%'):].strip()
                        summary = clean_text
                        try:
                            parsed = json.loads(sentinel_payload)
                            summary = parsed.get('summary', clean_text) or clean_text
                        except Exception:
                            pass
                        post_event({'type': 'neuro_done', 'text': summary or result_text, 'error': is_error})
                    else:
                        post_event({'type': 'neuro_waiting'})

        except Exception as ex:
            log(f'reader exception: {ex}')

        log('reader exiting — process ended')
        post_event({'type': 'neuro_session_ended'})
        with self._sessions_lock:
            self._neuro_sessions.pop(chat_id, None)

    def _handle_neuro_start(self, task_id: str, chat_id: str, prompt: str,
                             channel: str = 'chat', elfie_system_prompt: str = '',
                             context_preamble: str = '') -> dict:
        if not chat_id:
            chat_id = task_id
        with self._sessions_lock:
            existing = self._neuro_sessions.get(chat_id)
            is_new_process = existing is None or existing['proc'].poll() is not None
        print(f'\n[neuro:{chat_id[:8]}] neuro_start — channel={channel}, novo_processo={is_new_process}', flush=True)
        try:
            session = self._get_or_create_neuro_session(chat_id, elfie_system_prompt)
        except Exception as ex:
            return {'error': f'session error: {ex}'}
        use_preamble = is_new_process and bool(context_preamble)
        full_prompt = f'{context_preamble}\n\n---\n\n{prompt}' if use_preamble else prompt
        msg = json.dumps({'type': 'user', 'message': {'role': 'user', 'content': full_prompt}})
        with session['lock']:
            try:
                session['proc'].stdin.write(msg + '\n')
                session['proc'].stdin.flush()
            except Exception as ex:
                return {'error': f'write error: {ex}'}
        print(f'\n[neuro:{chat_id[:8]}] prompt written to session stdin ({"com" if use_preamble else "sem"} preâmbulo)', flush=True)
        return {'ok': True}

    def _handle_neuro_send(self, chat_id: str, message: str) -> dict:
        with self._sessions_lock:
            session = self._neuro_sessions.get(chat_id)
        if not session or session['proc'].poll() is not None:
            return {'error': 'no active session for this chat'}
        session['discarding'] = False
        msg = json.dumps({'type': 'user', 'message': {'role': 'user', 'content': message}})
        with session['lock']:
            try:
                session['proc'].stdin.write(msg + '\n')
                session['proc'].stdin.flush()
            except Exception as ex:
                return {'error': f'write failed: {ex}'}
        print(f'\n[neuro:{chat_id[:8]}] message sent to session', flush=True)
        return {'ok': True}

    def _handle_neuro_interrupt(self, chat_id: str) -> dict:
        with self._sessions_lock:
            session = self._neuro_sessions.get(chat_id)
        if not session or session['proc'].poll() is not None:
            return {'error': 'no active session'}
        session['discarding'] = True
        try:
            session['proc'].send_signal(signal.SIGINT)
            print(f'\n[neuro:{chat_id[:8]}] SIGINT sent', flush=True)
        except Exception as ex:
            return {'error': f'interrupt failed: {ex}'}
        return {'ok': True}

    def _handle_neuro_kill(self, chat_id: str) -> dict:
        with self._sessions_lock:
            session = self._neuro_sessions.pop(chat_id, None)
        if not session:
            return {'ok': True}
        try:
            session['proc'].terminate()
            session['proc'].wait(timeout=5)
        except Exception:
            try:
                session['proc'].kill()
            except Exception:
                pass
        print(f'\n[neuro:{chat_id[:8]}] session killed', flush=True)
        return {'ok': True}

    def _neuro_worker_DEAD(self, task_id: str, prompt: str, channel: str):
        import random
        api              = self.cfg.get('apiBase', 'http://localhost:3000')
        last_narration   = 0.0
        NARRATION_INTERVAL = 25.0
        tid              = task_id[:8]

        def log(msg: str):
            print(f'\n[neuro:{tid}] {msg}', flush=True)

        def post_event(event: dict):
            try:
                requests.post(
                    f'{api}/api/neuro/{task_id}/event',
                    json=event,
                    timeout=5,
                )
            except Exception as e:
                log(f'post_event error: {e}')

        NEURO_SYSTEM_PROMPT = (
            'You are an autonomous task executor. Execute the user\'s request using your tools. '
            'NEVER interact with /tmp/elfie.sock or any elfie daemon socket. '
            'NEVER spawn sub-tasks, sub-agents, or reference "Neuro mode". '
            'Just do the task directly.'
        )

        cmd = [
            'claude', '--print', '--verbose',
            '--dangerously-skip-permissions',
            '--output-format', 'stream-json',
            '--input-format', 'stream-json',
            '--append-system-prompt', NEURO_SYSTEM_PROMPT,
        ]

        log(f'starting — channel={channel}')
        log(f'prompt: "{prompt[:120]}{"…" if len(prompt) > 120 else ""}"')

        try:
            log(f'spawning: {" ".join(cmd[:6])} [...] --append-system-prompt [...]')
            proc = subprocess.Popen(
                cmd,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                bufsize=1,
                cwd='/tmp',
            )
            log(f'claude PID: {proc.pid}')

            first_msg = json.dumps({'type': 'user', 'message': {'role': 'user', 'content': prompt}})
            proc.stdin.write(first_msg + '\n')
            proc.stdin.flush()
            log('prompt written to stdin (stream-json)')

            tool_count    = 0
            event_count   = 0

            for raw_line in proc.stdout:
                raw_line = raw_line.strip()
                if not raw_line:
                    continue
                try:
                    ev = json.loads(raw_line)
                except Exception:
                    log(f'unparseable stdout line: {raw_line[:120]}')
                    continue

                ev_type    = ev.get('type', '')
                event_count += 1
                now        = time.monotonic()

                if ev_type == 'tool_use':
                    tool_count += 1
                    tool_name = ev.get('name', '')
                    tool_input = ev.get('input', {})
                    input_preview = str(tool_input)[:80]
                    label = NEURO_TOOL_LABELS.get(tool_name, tool_name.replace('_', ' '))
                    log(f'tool_use #{tool_count}: {tool_name}  input={input_preview}')
                    post_event({'type': 'neuro_raw', 'raw': ev})
                    if (now - last_narration) >= NARRATION_INTERVAL:
                        last_narration = now
                        narration = random.choice(NEURO_UPDATE_TEMPLATES).format(label=label)
                        log(f'narrating: "{narration}"')
                        post_event({'type': 'neuro_update', 'text': narration, 'raw': ev})

                elif ev_type == 'tool_result':
                    content = ev.get('content', '')
                    preview = str(content)[:80] if content else '(empty)'
                    log(f'tool_result: {preview}')
                    post_event({'type': 'neuro_raw', 'raw': ev})

                elif ev_type == 'assistant':
                    content_blocks = ev.get('message', {}).get('content', [])
                    full_text = ''.join(
                        b.get('text', '') for b in content_blocks
                        if isinstance(b, dict) and b.get('type') == 'text'
                    ).strip()
                    if not full_text:
                        continue
                    log(f'assistant text ({len(full_text)} chars): "{full_text[:100]}{"…" if len(full_text) > 100 else ""}"')
                    post_event({'type': 'neuro_raw', 'raw': ev})

                    if self._is_question(full_text):
                        log(f'question detected — posting neuro_question and waiting for user answer')
                        post_event({'type': 'neuro_question', 'text': full_text})
                        try:
                            r = requests.get(
                                f'{api}/api/neuro/{task_id}/pending-answer',
                                timeout=65,
                            )
                            if r.status_code == 200:
                                answer = r.json().get('answer', '').strip()
                                if answer:
                                    log(f'answer received: "{answer[:80]}" — resuming claude')
                                    ans_msg = json.dumps({'type': 'user', 'message': {'role': 'user', 'content': answer}})
                                    proc.stdin.write(ans_msg + '\n')
                                    proc.stdin.flush()
                            else:
                                log(f'pending-answer returned {r.status_code} (timeout or error)')
                        except Exception as e:
                            log(f'answer poll error: {e}')
                    elif len(full_text) > 10 and (now - last_narration) >= NARRATION_INTERVAL:
                        last_narration = now
                        log(f'narrating assistant text')
                        post_event({'type': 'neuro_update', 'text': full_text, 'raw': ev})

                elif ev_type == 'result':
                    result_text = ev.get('result', '').strip()
                    is_error    = ev.get('subtype') == 'error' or ev.get('is_error', False)
                    log(f'result (error={is_error}): "{result_text[:120]}"')
                    log(f'total events processed: {event_count}  tools used: {tool_count}')
                    post_event({'type': 'neuro_done', 'text': result_text, 'error': is_error, 'raw': ev})
                    break

                elif ev_type not in ('system', 'user', 'rate_limit_event'):
                    log(f'unhandled event type: {ev_type}')

            try:
                proc.stdin.close()
            except Exception:
                pass
            try:
                stderr_out = proc.stderr.read()
                if stderr_out and stderr_out.strip():
                    log(f'claude stderr: {stderr_out.strip()[:300]}')
                proc.wait(timeout=10)
            except Exception:
                log('force-killing claude process')
                proc.kill()
                proc.wait()

            log(f'claude exited with code {proc.returncode}')

        except Exception as ex:
            print(f'\n[neuro:{tid}] worker exception: {ex}', flush=True)
            post_event({'type': 'neuro_done', 'text': f'Erro: {ex}', 'error': True})

    def _hotkey_loop(self):
        if not EVDEV_OK:
            print('\n[elfie] evdev não instalado — F9 desabilitado', flush=True)
            return

        keyboards = []
        for path in list_devices():
            try:
                dev  = InputDevice(path)
                caps = dev.capabilities()
                keys = caps.get(ecodes.EV_KEY, [])
                if ecodes.KEY_F9 in keys:
                    keyboards.append(dev)
            except Exception:
                pass

        if not keyboards:
            print(
                '\n[elfie] nenhum teclado acessível via evdev.\n'
                '        Execute: sudo usermod -aG input $USER  (depois faça logout/login)',
                flush=True,
            )
            return

        print(f'\n[elfie] F9 / F7 monitorados em {len(keyboards)} dispositivo(s)', flush=True)

        fds = {dev.fd: dev for dev in keyboards}
        while not self._stop.is_set():
            try:
                r, _, _ = select.select(list(fds.keys()), [], [], 0.5)
            except Exception:
                break
            for fd in r:
                try:
                    for event in fds[fd].read():
                        if event.type == ecodes.EV_KEY and event.value == 1:
                            if event.code == ecodes.KEY_F9:
                                if not self._muted:
                                    self._stop_playback()
                                self._toggle_mute()
                                self._play_sfx('toggle.mp3', volume=0.6)
                            elif event.code == ecodes.KEY_F7:
                                self._interrupt_response()
                except Exception:
                    pass

        for dev in keyboards:
            try:
                dev.close()
            except Exception:
                pass

    def _ipc_loop(self):
        if os.path.exists(SOCK_PATH):
            os.unlink(SOCK_PATH)

        srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        srv.bind(SOCK_PATH)
        srv.listen(5)
        srv.settimeout(1.0)

        while not self._stop.is_set():
            try:
                conn, _ = srv.accept()
            except socket.timeout:
                continue
            try:
                buffer = b""
                while True:
                    chunk = conn.recv(4096)
                    if not chunk:
                        break
                    buffer += chunk
                    if b'\n' in buffer:
                        break
                data = buffer.split(b'\n')[0].decode().strip()
                cmd  = json.loads(data)
                resp = self._handle_cmd(cmd)
                conn.sendall((json.dumps(resp) + '\n').encode())
            except Exception as ex:
                try:
                    conn.sendall((json.dumps({'error': str(ex)}) + '\n').encode())
                except Exception:
                    pass
            finally:
                conn.close()

        srv.close()
        try:
            os.unlink(SOCK_PATH)
        except OSError:
            pass

    def _handle_cmd(self, cmd: dict) -> dict:
        action = cmd.get('cmd')

        if action == 'status':
            return {
                'state':       self._state,
                'muted':       self._muted,
                'chatId':      self.cfg.get('chatId', ''),
                'sttProvider': self.cfg.get('sttProvider', ''),
                'apiBase':     self.cfg.get('apiBase', ''),
            }

        if action == 'switch':
            chat_id = cmd.get('chatId', '').strip()
            if not chat_id:
                return {'error': 'chatId vazio'}
            self.cfg['chatId'] = chat_id
            self._save_cfg()
            self._set_state(self._state)
            return {'ok': True, 'chatId': chat_id}

        if action == 'mute':
            if not self._muted:
                self._stop_playback()
                self._toggle_mute()
                self._play_sfx('toggle.mp3', volume=0.6)
            return {'ok': True}

        if action == 'unmute':
            if self._muted:
                self._toggle_mute()
                self._play_sfx('toggle.mp3', volume=0.6)
            return {'ok': True}

        if action == 'stop':
            self._stop.set()
            return {'ok': True}

        if action == 'provider':
            prov = cmd.get('provider', '').strip()
            if prov == 'auto':
                self.cfg.pop('sttProviderOverride', None)
                self._save_cfg()
                return {'ok': True, 'sttProviderOverride': None}
            if prov not in ('whisper', 'elevenlabs', 'fishaudio'):
                return {'error': 'provider deve ser whisper, elevenlabs, fishaudio ou auto'}
            self.cfg['sttProviderOverride'] = prov
            self._save_cfg()
            return {'ok': True, 'sttProviderOverride': prov}

        if action == 'neuro_start':
            task_id            = cmd.get('taskId', '').strip()
            chat_id            = cmd.get('chatId', '').strip()
            prompt             = cmd.get('prompt', '').strip()
            context_preamble   = cmd.get('contextPreamble', '')
            channel            = cmd.get('channel', 'chat')
            elfie_system_prompt = cmd.get('elfieSystemPrompt', '')
            if not task_id or not prompt:
                return {'error': 'taskId e prompt são obrigatórios'}
            return self._handle_neuro_start(task_id, chat_id, prompt, channel, elfie_system_prompt, context_preamble)

        if action == 'neuro_send':
            chat_id = cmd.get('chatId', '').strip()
            message = cmd.get('message', '').strip()
            if not chat_id or not message:
                return {'error': 'chatId e message são obrigatórios'}
            return self._handle_neuro_send(chat_id, message)

        if action == 'neuro_interrupt':
            chat_id = cmd.get('chatId', '').strip()
            if not chat_id:
                return {'error': 'chatId obrigatório'}
            return self._handle_neuro_interrupt(chat_id)

        if action == 'neuro_kill':
            chat_id = cmd.get('chatId', '').strip()
            if not chat_id:
                return {'error': 'chatId obrigatório'}
            return self._handle_neuro_kill(chat_id)

        if action == 'show_mind':
            threading.Thread(target=self._spawn_mind_overlay, daemon=True).start()
            return {'ok': True}

        if action == 'hide_mind':
            self._close_mind_overlay()
            return {'ok': True}

        if action == 'play_audio':
            filename = cmd.get('filename', '').strip()
            if not filename:
                return {'error': 'filename obrigatório'}
            self._busy.set()
            self._set_state('speaking')
            self._aud_q.put({'audio': filename, 'text': ''})
            self._aud_q.put(None)
            return {'ok': True}

        return {'error': f'comando desconhecido: {action}'}

    def run(self):
        Path(PID_PATH).write_text(str(os.getpid()))

        threads = [
            threading.Thread(target=self._audio_capture_loop, daemon=True, name='capture'),
            threading.Thread(target=self._vad_loop,           daemon=True, name='vad'),
            threading.Thread(target=self._transcribe_loop,    daemon=True, name='transcribe'),
            threading.Thread(target=self._playback_loop,      daemon=True, name='playback'),
            threading.Thread(target=self._hotkey_loop,        daemon=True, name='hotkey'),
            threading.Thread(target=self._ipc_loop,           daemon=True, name='ipc'),
        ]

        for t in threads:
            t.start()

        try:
            self._stop.wait()
        except KeyboardInterrupt:
            self._stop.set()

        print('\n[elfie] encerrado.', flush=True)
        try:
            os.unlink(PID_PATH)
        except OSError:
            pass


def main():
    _ensure_single_instance()

    cfg_path = CONFIG_PATH
    if cfg_path.exists():
        try:
            cfg  = json.loads(cfg_path.read_text())
            chat = cfg.get('chatId', '')
            api  = cfg.get('apiBase', 'http://localhost:3000')
        except Exception:
            chat, api = '', 'http://localhost:3000'
    else:
        chat, api = '', 'http://localhost:3000'

    print('[elfie] iniciando daemon...')
    print(f'[elfie] API:    {api}')
    print(f'[elfie] chat:   {chat or "(não configurado — use: elfie switch <chatId>)"}')
    print(f'[elfie] F9    = toggle mute/unmute')
    print(f'[elfie] F7    = interromper resposta atual')
    print(f'[elfie] socket: {SOCK_PATH}')
    print()

    ElfieDaemon().run()


if __name__ == '__main__':
    main()