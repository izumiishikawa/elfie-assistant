#!/usr/bin/env python3

import base64
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
from urllib.parse import quote

import numpy as np
import requests

import platform_compat as plat

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

try:
    import websocket  # websocket-client — usado só pelo modo Inworld S2S
    WEBSOCKET_OK = True
except ImportError:
    WEBSOCKET_OK = False

try:
    # Módulo autocontido (não importa nada daqui, sem risco de import circular) —
    # ver seu docstring pro porquê de ser um arquivo separado. Mesmo guard de
    # ImportError que 'websocket' acima: se websocket-client não estiver
    # instalado, este import também falharia (ele importa websocket também),
    # e _inworld_loop já sai cedo checando WEBSOCKET_OK antes de tentar usar
    # run_inworld_call — então None aqui é seguro.
    from elfie_inworld_call import run_inworld_call
except ImportError:
    run_inworld_call = None

# Caminhos e IPC saem da camada de compatibilidade. No Linux dão exatamente os
# mesmos valores de antes (/tmp/elfie.sock, /tmp/elfie.pid, ~/.config/elfie).
CONFIG_PATH = plat.CONFIG_PATH
SOCK_PATH   = plat.SOCK_PATH
PID_PATH    = plat.PID_PATH
MAX_SELECTED_TEXT_CHARS = 6000

# === Log diagnóstico da sessão Inworld =======================================
# Depois de várias rodadas de "conserto teórico -> usuário testa -> ainda quebrado",
# parou de fazer sentido continuar advinhando pelo comportamento reportado. Isso aqui
# registra, com timestamp, CADA decisão que afeta se o usuário é ouvido: toda mensagem
# que chega da Inworld, toda decisão do gate do mic (silêncio ou voz, e POR QUÊ), todo
# start/kill/reap do player de áudio. Ligado só com INWORLD_DEBUG=1 (variável de
# ambiente do daemon, não do servidor) — em uso normal fica desligado, sem custo.
# Vai pra ARQUIVO separado, não pro stdout: o terminal já tem o VU meter reescrevendo a
# mesma linha com \r toda hora, um log intercalado ali seria ilegível.
INWORLD_DEBUG = os.environ.get('INWORLD_DEBUG') == '1'
INWORLD_DEBUG_LOG_PATH = Path(__file__).parent / 'inworld_debug.log'
_inworld_debug_lock = threading.Lock()


def idbg(tag: str, **fields):
    """Loga um evento do diagnóstico Inworld. No-op se INWORLD_DEBUG não estiver setado."""
    if not INWORLD_DEBUG:
        return
    ts = time.strftime('%H:%M:%S', time.localtime()) + f'.{int(time.time() * 1000) % 1000:03d}'
    parts = ' '.join(f'{k}={v!r}' for k, v in fields.items())
    line = f'{ts} [{tag}] {parts}\n'
    try:
        with _inworld_debug_lock:
            with open(INWORLD_DEBUG_LOG_PATH, 'a') as f:
                f.write(line)
    except Exception:
        pass  # log nunca pode derrubar a sessão de voz


def _extract_ids(msg: dict) -> dict:
    """Varre um payload de evento da Inworld atrás de qualquer campo de
    correlação (session id, response id, event id, execution id, span id...).
    Não presume o nome exato do campo — o suporte deles pede 'Session ID /
    Execution ID' e 'Span ID' pra localizar a interação nos traces, e a gente
    nunca tinha capturado nada disso (só o 'type' de cada mensagem). Olha o
    nível de topo e um nível de aninhamento (cobre session.created's
    `session: {id: ...}`, response.created's `response: {id: ...}`, etc.)."""
    found = {}

    def _scan(d, prefix=''):
        if not isinstance(d, dict):
            return
        for k, v in d.items():
            if k == 'id' or k.endswith('_id'):
                key = f'{prefix}{k}' if prefix else k
                found[key] = v

    _scan(msg)
    for k, v in msg.items():
        if isinstance(v, dict):
            _scan(v, prefix=f'{k}.')
    return found


def _get_selected_text() -> str:
    return plat.get_selected_text(MAX_SELECTED_TEXT_CHARS)


def _ensure_single_instance():
    if not os.path.exists(PID_PATH):
        return
    try:
        old_pid = int(Path(PID_PATH).read_text().strip())
    except (OSError, ValueError):
        return
    if old_pid == os.getpid():
        return
    if not plat.pid_alive(old_pid):
        return

    print(f'[elfie] encerrando instância anterior (pid {old_pid})...', flush=True)
    try:
        plat.kill_pid(old_pid)
    except OSError:
        return
    for _ in range(50):
        time.sleep(0.1)
        if not plat.pid_alive(old_pid):
            return
    print(f'[elfie] instância anterior (pid {old_pid}) não respondeu, forçando...', flush=True)
    try:
        plat.kill_pid(old_pid, force=True)
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

VAD_AGGRESSIVENESS = 3
AMBIENT_EMA_ALPHA   = 0.001

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
        # RLock, não Lock: o handler de audio.delta precisa segurar esse lock enquanto
        # CHAMA start_playback() (que também toma o lock) pra ficar atômico contra
        # stop_playback() fechando o stdin no meio — Lock comum trava (deadlock) numa
        # reentrada assim; RLock permite a mesma thread pegar de novo.
        self._play_lock = threading.RLock()
        self._play_proc = None
        self._session   = requests.Session()

        # Modo "fast lane" Inworld S2S — ativo só quando o character ativo tem o
        # toggle ligado (ver Character.inworldRealtimeEnabled). Enquanto ativo, o
        # _vad_loop clássico fica em pausa (ver checagem lá embaixo) pra não
        # transcrever/duplicar a mesma fala pelos dois caminhos.
        self._inworld_active = threading.Event()

        self._blk_q = queue.Queue(maxsize=300)
        self._rec_q = queue.Queue()
        self._aud_q = queue.Queue()

        self._energy    = 0.0
        self._start_thr = START_MIN

        self._active_overlay_proc: subprocess.Popen | None = None
        self._tool_overlay_only = False
        self._mind_overlay_proc: subprocess.Popen | None = None
        self._skill_evolution_proc: subprocess.Popen | None = None

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

    def _mic_pump(self, ws, proc, bytes_per_block, should_mute, silence_block, session_alive):
        """Bombeia áudio de um ffmpeg de captura pro websocket do Inworld.

        should_mute() decide se o bloco lido vira silêncio (ela está falando, ou o
        usuário mutou). O stream em si NUNCA é interrompido — ver comentário no corpo.

        Retorna True se chegou a mandar pelo menos um bloco — o supervisor em
        mic_sender usa isso pra distinguir "a captura funcionou e caiu depois"
        (reabre rápido) de "nem conseguiu começar" (reabre com backoff maior).
        Sair daqui NÃO encerra mais a captura pra sempre: quem chamou reabre.
        """
        sent_any = False
        while session_alive():
            raw = proc.stdout.read(bytes_per_block)
            if not raw or len(raw) < bytes_per_block:
                return sent_any  # EOF: o ffmpeg morreu — o supervisor reabre
            # Continua LENDO do ffmpeg mesmo mudo/falando (senão o pipe enche e trava).
            #
            # Quando não é pra ela ouvir, manda SILÊNCIO em vez de pular o bloco. Pular
            # (o `continue` de antes) era metade da causa das frases alucinadas: a
            # Inworld recebia uma linha do tempo picotada, com pedaços de fala colados
            # sem o intervalo que existiu de verdade. STT alimentado com áudio emendado
            # assim inventa frase — não era ela "alucinando", era a gente mandando áudio
            # mutilado. Silêncio mantém o stream contínuo e o VAD deles vê pausa de
            # verdade.
            #
            # O gate NÃO olha mais se o processo ffplay está vivo: durante uma tool call
            # o stop_playback é adiado de propósito, então ele fica vivo e ocioso a tool
            # inteira — era isso que fazia ela "parar de escutar depois de executar uma
            # ferramenta". Ver o audio_clock montado em _run_inworld_session.
            if should_mute():
                raw = silence_block
            # Só pra alimentar o VU do overlay — a Inworld faz o próprio VAD semântico do
            # lado deles, isso aqui não afeta detecção de turno nenhuma.
            if self._start_thr > 0:
                block = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
                self._send_energy_to_overlay(min(1.0, _speech_energy(block) / self._start_thr))
            try:
                ws.send(json.dumps({
                    'type': 'input_audio_buffer.append',
                    'audio': base64.b64encode(raw).decode('ascii'),
                }))
                sent_any = True
            except Exception:
                # Websocket caiu — aí é a sessão inteira, não só a captura. Não adianta
                # reabrir o ffmpeg; session_alive() vai ficar falso logo em seguida.
                return sent_any
        return sent_any

    def _spawn_skill_evolution_overlay(self, line: str, skill_name: str):
        # Fica de pé (como o 'mind') até um 'resolve' ou 'close' pelo stdin — instalar de
        # verdade (web_fetch, test_skill, edit_skill, testar de novo) pode levar bem mais
        # que a animação de abertura, e o usuário pediu overlay em tela o tempo todo
        # enquanto isso roda. Guarda o proc pra _resolve_skill_evolution poder escrever
        # nele mais tarde, quando test_skill de fato confirmar sucesso.
        old = self._skill_evolution_proc
        if old and old.poll() is None:
            try:
                old.stdin.write((json.dumps({'close': True}) + '\n').encode())
                old.stdin.flush()
                old.stdin.close()
            except Exception:
                pass
        try:
            script = Path(__file__).parent / 'elfie_overlay.py'
            if not script.exists():
                return
            payload = json.dumps({'line': line, 'skillName': skill_name})
            self._skill_evolution_proc = subprocess.Popen(
                [sys.executable, str(script), 'skill_evolution', payload],
                stdin=subprocess.PIPE,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
            )
        except Exception:
            pass

    def _resolve_skill_evolution(self, skill_name: str, success: bool):
        proc = self._skill_evolution_proc
        if not proc or proc.poll() is not None:
            return
        try:
            proc.stdin.write((json.dumps({'resolve': {'skillName': skill_name, 'success': success}}) + '\n').encode())
            proc.stdin.flush()
        except Exception:
            pass

    def _update_skill_evolution_status(self, line: str, kanji: str = ''):
        # Reusa a mesma tela: em vez de só a animação fixa de abertura, o modelo pode
        # empurrar avisos de progresso enquanto ainda tá trabalhando (fetch da doc, teste,
        # ajuste) — ver window.updateStatus em skill_evolution.html e o tool
        # forge_skill_status em chats.controller.js/inworldRealtime.js.
        proc = self._skill_evolution_proc
        if not proc or proc.poll() is not None:
            return
        try:
            proc.stdin.write((json.dumps({'status': {'line': line, 'kanji': kanji}}) + '\n').encode())
            proc.stdin.flush()
        except Exception:
            pass

    def _notice_skill_evolution(self, line: str):
        # 告 (KOKU) toast — general announcement mid-flow, doesn't end the overlay.
        proc = self._skill_evolution_proc
        if not proc or proc.poll() is not None:
            return
        try:
            proc.stdin.write((json.dumps({'notice': {'line': line}}) + '\n').encode())
            proc.stdin.flush()
        except Exception:
            pass

    def _fail_skill_evolution(self, line: str, skill_name: str):
        # 失敗した (SHIPAISHITA) toast — a SUB-step failed, not the whole flow (she's
        # about to retry with edit_skill) — doesn't end the overlay, unlike
        # skill_evolution_resolve with success=False (the terminal give-up case).
        proc = self._skill_evolution_proc
        if not proc or proc.poll() is not None:
            return
        try:
            proc.stdin.write((json.dumps({'failure': {'line': line, 'skillName': skill_name}}) + '\n').encode())
            proc.stdin.flush()
        except Exception:
            pass

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

    def _send_kanji_to_overlay(self, ch: str):
        proc = self._active_overlay_proc
        if proc and proc.poll() is None:
            try:
                proc.stdin.write((json.dumps({'kanji': ch}) + '\n').encode())
                proc.stdin.flush()
            except Exception:
                self._active_overlay_proc = None

    _GREAT_SAGE_CUES = {
        'warning': ('warning.mp3', '告'),
        'ryo':     ('ryo.mp3', '了'),
    }

    def _great_sage_enabled(self) -> bool:
        api = self.cfg.get('apiBase', 'http://localhost:3000')
        try:
            r = self._session.get(f'{api}/api/characters', timeout=3)
            r.raise_for_status()
            data = r.json()
            active_id = str(data.get('activeCharacterId') or '')
            for c in data.get('characters', []):
                if str(c.get('_id')) == active_id:
                    return bool(c.get('greatSageWarnings', True))
            return True
        except Exception:
            return True

    def _cue_great_sage(self, cue: str):
        pair = self._GREAT_SAGE_CUES.get(cue)
        if not pair:
            return
        if not self._great_sage_enabled():
            return
        filename, kanji = pair
        self._ensure_active_overlay()
        self._play_sfx(filename)
        self._send_kanji_to_overlay(kanji)

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
        idbg('toggle_mute', muted=self._muted)
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
        # Captura "crua" pro VU meter / wake word — no Linux vai no dispositivo
        # default (não no elfie_mic_aec, que é só do modo Inworld).
        cmd = plat.mic_capture_cmd(SAMPLE_RATE, device='default' if plat.IS_LINUX else None)
        bytes_per_block = BLOCK_SIZE * 2

        while not self._stop.is_set():
            try:
                proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                        **plat.popen_flags())
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
        start_thr   = START_MIN
        stop_thr    = STOP_MIN
        ambient_ema = START_MIN

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
                    ambient     = sum(calib) / CALIB_FRAMES
                    ambient_ema = ambient
                    start_thr   = max(START_MIN, ambient * START_MULT)
                    stop_thr    = max(STOP_MIN,  ambient * STOP_MULT)
                    self._start_thr = start_thr
                    self._set_state('listening')
                continue

            if self._muted or self._busy.is_set() or self._inworld_active.is_set():
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
                # acompanha o piso de ruído/música ambiente lentamente (só fora de fala
                # detectada), pra não travar o threshold no que foi medido na calibração
                # inicial e passar a marcar som ambiente constante como voz.
                ambient_ema = ambient_ema * (1 - AMBIENT_EMA_ALPHA) + e * AMBIENT_EMA_ALPHA
                start_thr   = max(START_MIN, ambient_ema * START_MULT)
                stop_thr    = max(STOP_MIN,  ambient_ema * STOP_MULT)
                self._start_thr = start_thr

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

            selected_text = _get_selected_text()

            self._set_state('processing')
            self._stream_voice(api, chat, transcript, selected_text)

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
            r.json()
            # NÃO troca mais de chat por tamanho. Isso existia como único freio
            # pro histórico que a API montava (ela mandava chat.messages inteiro
            # pro modelo), mas o preço era abandonar a conversa no meio ao passar
            # de 40 mensagens e perder o contexto de uma vez. O freio agora é uma
            # janela rolante do lado da API (HISTORY_WINDOW_MESSAGES em
            # chats.controller.js): a conversa continua a mesma, só as mensagens
            # mais antigas param de ser reenviadas.
        except requests.HTTPError:
            raise
        except Exception:
            pass
        return chat_id

    def _process_voice_stream(self, r, api: str):
        buf = ''
        tool_flow_started = False
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
                    if not tool_flow_started:
                        tool_flow_started = True
                        self._cue_great_sage('ryo')
                        # Um 'started' só por stream (o servidor não manda um evento de
                        # "tool terminou" por tool aqui) — o par sai no fim do stream,
                        # abaixo. Cobre o buraco em que ela falava, saía do estado
                        # 'processing' e ficava minutos numa tool em silêncio total.
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

    def _stream_voice(self, api: str, chat_id: str, text: str, selected_text: str = ''):
        payload = {'text': text}
        if selected_text:
            payload['selectedText'] = selected_text
        try:
            with self._session.post(
                f'{api}/api/chats/{chat_id}/voice',
                json=payload,
                stream=True,
                timeout=60,
            ) as r:
                if r.status_code == 404:
                    chat_id = self._create_new_chat(api)
                    with self._session.post(
                        f'{api}/api/chats/{chat_id}/voice',
                        json=payload,
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

        # Fim do turno (inclusive se o stream morreu por erro): zera em vez de
        # decrementar, porque o clássico marca um 'started' por stream e um stream
        # cortado no meio nunca traria o par — o som ficaria tocando pra sempre.
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
                    plat.mp3_play_cmd(tmp_path, volume=22938 / 32768),
                    **plat.popen_flags(),
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

    # -- Inworld S2S ("fast lane") ---------------------------------------------
    # Modo alternativo de call: em vez do pipeline clássico (VAD local ->
    # transcribe -> /api/chats/:id/voice -> mp3 -> mpg123), abre uma sessão
    # full-duplex direto com a ponte do backend (api/src/inworldRealtime.js),
    # que fala com a Realtime API do Inworld. Sem tools além das registradas na
    # sessão (ver INWORLD_TOOLS + dynamic skills em inworldRealtime.js) — mesma
    # limitação do lado web (elfie-web/src/screens/InworldCallOverlay.tsx), e sem
    # paridade com o roster completo do chat de texto (Gmail/Calendar/Drive/Play
    # Console/browser-agent/computer-control ficam de fora, de propósito). Nomes de evento vindos
    # da doc do Inworld, não confirmados contra tráfego real: qualquer evento não
    # reconhecido é só logado, nunca derruba a sessão.

    def _inworld_loop(self):
        if not WEBSOCKET_OK:
            print('\n[elfie] websocket-client não instalado — modo Inworld desativado '
                  '(pip3 install --break-system-packages websocket-client)', flush=True)
            return

        while not self._stop.is_set():
            api = self.cfg.get('apiBase', 'http://localhost:3000')
            enabled = False
            try:
                r = self._session.get(f'{api}/api/characters', timeout=5)
                r.raise_for_status()
                data  = r.json()
                chars = data.get('characters') or []
                active_id = str(data.get('activeCharacterId') or '')
                active = next((c for c in chars if str(c.get('_id')) == active_id), None) \
                    or (chars[0] if chars else None)
                enabled = bool(active and active.get('inworldRealtimeEnabled'))
            except Exception:
                pass

            if not enabled or self._muted or self._busy.is_set():
                time.sleep(3)
                continue

            self._inworld_active.set()
            try:
                # Voltado pra versão antiga a pedido do usuário (2026-09-04) —
                # a nova (elfie_inworld_call.py, run_inworld_call) continua no
                # arquivo, importada e funcional, só não é chamada daqui agora.
                # Trocar de volta é só reverter esta linha pra run_inworld_call(self, api).
                self._run_inworld_session(api)
            except Exception as ex:
                print(f'\n[elfie] inworld session error: {ex}', flush=True)
            finally:
                self._inworld_active.clear()
                if not self._muted:
                    self._set_state('listening')
            time.sleep(1)

    def _run_inworld_session(self, api):
        idbg('session_start', api=api)
        ws_url = api.replace('https://', 'wss://').replace('http://', 'ws://') + '/ws/inworld-call'
        # Snapshot inicial da seleção de tela — vai nas instructions do session.update
        # (via query param), cobre "liguei já olhando pra algo". Atualizações depois disso
        # vêm de _refresh_selection() abaixo, disparado a cada vez que a Inworld detecta
        # que o usuário começou a falar de novo (input_audio_buffer.speech_started) — cada
        # nova fala reconsulta a seleção atual e manda pro servidor injetar como contexto
        # fresco, do mesmo jeito que o pipeline clássico faz a cada mensagem HTTP nova.
        selected_text = _get_selected_text()
        if selected_text:
            ws_url += '?selectedText=' + quote(selected_text)

        mic_proc  = {'p': None}
        # 'closing': stop_playback() já fechou o stdin deste processo e ele está só
        # drenando o que sobrou no buffer. Ele continua VIVO e audível nesse estado (é o
        # ponto do -autoexit), então poll() ainda devolve None — sem esse flag não havia
        # como distinguir "tocando e aceitando áudio novo" de "tocando o resto e já
        # fechado", que é exatamente onde nasciam a fala sobreposta e a autoescuta.
        play_proc = {'p': None, 'closing': False}
        # Até quando o áudio JÁ ESCRITO no ffplay ainda está saindo pelas caixas.
        #
        # Isso substitui "o processo ffplay está vivo" como sinal de "ela está falando",
        # que era simplesmente errado: durante uma tool call o stop_playback é adiado de
        # propósito (ver on_response_done/pending_tools), então o ffplay fica VIVO e
        # OCIOSO com o stdin aberto pela duração inteira da tool. O gate do mic olhava
        # poll() e ficava fechado esse tempo todo — "ela para de me escutar depois que
        # executa uma ferramenta".
        #
        # Como o formato de saída é fixo (PCM s16le mono 24kHz = 48000 bytes/s), dá pra
        # saber com precisão quanto tempo de fala cada chunk representa. O acumulador usa
        # max(ends_at, now) pra lidar com lacunas: se o áudio anterior já acabou, a
        # contagem recomeça de agora em vez de somar em cima de um tempo já vencido.
        OUTPUT_BYTES_PER_SEC = 24000 * 2
        SPEECH_TAIL_S = 0.25  # margem pro buffer do sink + eco da sala
        audio_clock = {'ends_at': 0.0}
        audio_burst = {'active': False}  # só pro log: marca começo/fim de rajada de audio.delta
        session_done = threading.Event()
        assistant_transcript = {'text': ''}
        tool_flow = {'started': False}
        stop_timer = {'t': None}
        last_selection = {'text': selected_text}
        # Um turno com tool calls vira VÁRIAS respostas Inworld em sequência (response.done
        # dispara por RODADA de tool, já confirmado — ver o fix do 'ryo' repetindo). Fechar o
        # ffplay em CADA response.done corta e reabre o pipe de áudio entre rodadas — se a
        # próxima rodada começar antes do ffplay antigo realmente sair (drena o buffer todo,
        # não é instantâneo), o audio.delta seguinte tenta escrever num stdin já fechado, cai
        # no except, zera play_proc['p'] achando que ela parou de falar enquanto o processo
        # antigo ainda tá tocando de verdade — dois ffplay vivos ao mesmo tempo (fala
        # sobreposta) E o mic_sender destrava cedo demais achando que ela não tá mais falando
        # (capta a própria voz dela pelas caixas, sem AEC, manda de volta pro VAD da Inworld —
        # loop de autoescuta).
        #
        # Um debounce baseado só em timer não dá conta: web_fetch/test_skill fazem requisição
        # HTTP de verdade, podem levar vários segundos — qualquer timer curto reabre o mic
        # achando que ela terminou enquanto uma tool ainda tá rodando; um timer longo o
        # suficiente pra cobrir isso deixaria QUALQUER fim de turno normal (sem tool call)
        # com vários segundos de mic mudo por nada. Em vez disso, o servidor
        # (inworldRealtime.js, handleToolCall) avisa o daemon via elfie.tool_executing /
        # elfie.tool_result_submitted exatamente quando uma tool está rodando de verdade —
        # response.done só agenda o fechamento se NENHUMA tool estiver em voo; senão fica
        # pendente até a última tool em voo terminar (pending_tools chega a 0).
        STOP_DEBOUNCE_S = 0.6
        pending_tools = {'count': 0}
        response_done_pending = {'v': False}

        def cancel_scheduled_stop():
            if stop_timer['t']:
                stop_timer['t'].cancel()
                stop_timer['t'] = None

        def finalize_stop():
            stop_playback()
            if not self._muted:
                self._set_state('listening')

        def schedule_stop_playback():
            # NUNCA agenda o fechamento pra antes do áudio já bufferizado acabar de
            # tocar. response.done (e o fim da última tool) chegam quase junto com o
            # ÚLTIMO chunk, não com o último som: o TTS gera muito mais rápido que o
            # tempo real de fala, então numa frase longa o ffplay pode ter 20s+ de áudio
            # ainda por sair quando o debounce fixo de 0.6s já fechou o stdin e marcou
            # closing=True. A partir daí, o primeiro audio.delta da rodada SEGUINTE
            # (continuação depois de tool, ou nova resposta) caía no ramo
            # kill_playback_now('fala nova antes da anterior terminar') e matava o
            # processo com a frase pela metade — o SIGTERM descarta o buffer inteiro.
            # Era exatamente isso o "ela é cortada no meio quando a frase é longa": o
            # corte não vinha do modelo nem da rede, vinha daqui, e só aparecia em frase
            # longa porque é onde a sobra de buffer é maior que a janela do debounce.
            #
            # Com o delay abaixo, o stdin só fecha quando ela está de fato inaudível —
            # e qualquer chunk novo que chegue antes disso cancela o timer
            # (cancel_scheduled_stop no handler de audio.delta) e é só ANEXADO no mesmo
            # player, que é a emenda contínua e sem corte que a gente quer. O gate do
            # mic continua saindo do audio_clock, independente deste timer.
            remaining = audio_clock['ends_at'] + SPEECH_TAIL_S - time.monotonic()
            delay = max(STOP_DEBOUNCE_S, remaining)
            idbg('schedule_stop_playback', in_s=round(delay, 3),
                 remaining_audio_s=round(remaining, 3))
            stop_timer['t'] = threading.Timer(delay, finalize_stop)
            stop_timer['t'].start()

        def on_response_done():
            idbg('response_done', pending_tools=pending_tools['count'])
            if pending_tools['count'] > 0:
                response_done_pending['v'] = True
                return
            schedule_stop_playback()

        def start_playback():
            with self._play_lock:
                try:
                    # -sample_rate/-ch_layout, não -ar/-ac: nesta versão do ffmpeg (n9.0.1+) o
                    # demuxer raw PCM rejeita -ar/-ac com "Option not found" e o ffplay morre
                    # sozinho sem avisar (Popen só falha se o binário nem existir, não se ele
                    # sair logo depois com erro) — era por isso que não saía som nenhum.
                    # -autoexit: sai sozinho assim que esvaziar o buffer após o stdin
                    # fechar (EOF) — precisa disso porque response.done chega quase junto
                    # do último chunk (TTS gera mais rápido que o tempo real de fala), e
                    # SEM isso o stop_playback() tinha que decidir na hora entre matar
                    # cedo (cortava o final de toda fala) ou nunca matar (zumbi). Com
                    # autoexit ele mesmo termina no momento certo — ver stop_playback().
                    # PULSE_SINK manda a saída de áudio do ffplay (SDL2, sem flag de CLI
                    # pra dispositivo pulse) pro sink virtual com AEC (elfie_speaker_aec —
                    # ver ~/.config/pipewire/pipewire-pulse.conf.d/51-elfie-echo-cancel.conf)
                    # em vez do sink padrão do sistema. Precisa disso junto com o mic_sender
                    # lendo de elfie_mic_aec (não 'default') pra o cancelamento de eco
                    # funcionar de verdade — o módulo só cancela o que ele mesmo vê saindo
                    # pelo sink que ele monitora.
                    play_env = plat.playback_env()
                    play_proc['p'] = subprocess.Popen(
                        plat.playback_cmd(24000),
                        stdin=subprocess.PIPE, stderr=subprocess.PIPE, env=play_env,
                        **plat.popen_flags(),
                    )
                    play_proc['closing'] = False
                    self._play_proc = play_proc['p']
                    idbg('playback_started', pid=play_proc['p'].pid)

                    # Sem isso, o stderr do ffplay (se ele morrer/reclamar de algo) vai pro
                    # stderr herdado do daemon e pode ficar invisível, atropelado pelos \r
                    # do redraw do VU meter no terminal — lê e imprime explícito com prefixo.
                    proc_ref = play_proc['p']
                    def _drain_stderr(proc):
                        try:
                            for line in iter(proc.stderr.readline, b''):
                                if line.strip():
                                    print(f"\n[elfie] ffplay: {line.decode(errors='replace').strip()}", flush=True)
                        except Exception:
                            pass
                    threading.Thread(target=_drain_stderr, args=(proc_ref,), daemon=True, name='ffplay-stderr').start()
                except Exception as ex:
                    idbg('playback_start_failed', error=str(ex))
                    print(f'\n[elfie] inworld: falha ao iniciar playback: {ex}', flush=True)

        def stop_playback():
            # Só fecha o stdin (EOF) e deixa o -autoexit terminar o ffplay sozinho assim
            # que ele acabar de tocar o que já foi escrito — NÃO chama terminate() aqui.
            # response.done chega assim que a geração termina, bem antes do áudio já
            # bufferizado acabar de tocar (TTS é mais rápido que tempo real); matar na
            # hora cortava o final de toda resposta. play_proc['p'] só é limpo quando o
            # processo realmente sai (thread reaper abaixo), então mic_sender continua
            # mudo pelo tempo real de fala, não só até response.done.
            with self._play_lock:
                p = play_proc['p']
                if not p:
                    idbg('stop_playback_noop', reason='no active player')
                    return
                try: p.stdin.close()
                except Exception: pass
                # A partir daqui esse processo NÃO aceita mais áudio novo — qualquer
                # chunk que chegue depois disso pertence a uma fala nova e precisa de um
                # player novo, não de um write() num stdin fechado (ver audio.delta).
                play_proc['closing'] = True
                idbg('stop_playback_stdin_closed', pid=p.pid,
                     ends_at_delta_s=round(audio_clock['ends_at'] - time.monotonic(), 3))

            def _reap():
                try: p.wait(timeout=30)
                except Exception:
                    try: p.terminate()
                    except Exception: pass
                with self._play_lock:
                    if play_proc['p'] is p:
                        play_proc['p'] = None
                        play_proc['closing'] = False
                    if self._play_proc is p:
                        self._play_proc = None
                idbg('playback_reaped', pid=p.pid)
            threading.Thread(target=_reap, daemon=True, name='ffplay-reap').start()

        def kill_playback_now(reason: str):
            # Corte IMEDIATO, ao contrário de stop_playback() (que fecha o stdin e deixa
            # o -autoexit drenar): usado quando uma fala NOVA precisa começar enquanto a
            # anterior ainda está audível. Sem isso, o handler de audio.delta abria um
            # segundo ffplay por cima do primeiro — os dois tocando juntos era ela
            # "falando por cima dela mesma", e como o handle antigo era descartado sem o
            # processo morrer, o gate do mic reabria no meio da fala dela e ela se
            # escutava. Limpa o estado sob o lock e manda SIGTERM de forma síncrona
            # (terminate() não bloqueia), deixando só o wait() pra thread.
            with self._play_lock:
                p = play_proc['p']
                if not p:
                    return
                play_proc['p'] = None
                play_proc['closing'] = False
                if self._play_proc is p:
                    self._play_proc = None
                try: p.stdin.close()
                except Exception: pass
                try: p.terminate()
                except Exception: pass
                # O áudio que ainda estava bufferizado foi descartado junto com o
                # processo — ela para de ser audível AGORA, então o relógio de fala não
                # pode continuar apontando pro futuro (manteria o mic fechado à toa).
                audio_clock['ends_at'] = time.monotonic()
            idbg('playback_killed', pid=p.pid, reason=reason)
            print(f'\n[elfie] inworld: playback anterior cortado ({reason})', flush=True)

            def _reap_killed():
                try: p.wait(timeout=5)
                except Exception:
                    try: p.kill()
                    except Exception: pass
            threading.Thread(target=_reap_killed, daemon=True, name='ffplay-kill').start()

        def mic_sender(ws):
            # elfie_mic_aec (não 'default') — fonte virtual com AEC de verdade aplicado
            # (WebRTC, mesmo tipo do echoCancellation:true do browser), carregada em
            # ~/.config/pipewire/pipewire-pulse.conf.d/51-elfie-echo-cancel.conf. Antes
            # disso, a única defesa contra a Elfie se ouvir era o gate abaixo (mudo
            # enquanto play_proc['p'] existe) — funcionava na maioria dos casos, mas
            # qualquer imprecisão de timing (latência de buffer, eco de sala) ainda
            # vazava. Isso ataca a causa raiz em vez de tentar cronometrar melhor.
            #
            # SUPERVISIONADO: antes isso abria o ffmpeg UMA vez e, se ele morresse, o
            # `break` do read curto (EOF) saía do while e a thread ACABAVA — pra sempre.
            # A sessão continuava conectada, o terminal continuava mostrando "ouvindo..."
            # (aquele VU vem do _audio_capture_loop, que é outra captura, independente
            # desta), mas NENHUM áudio era mandado pro Inworld nunca mais. Exatamente o
            # "ela para de me escutar do nada", sem uma linha de erro no log — porque o
            # stderr do ffmpeg ia pra DEVNULL.
            #
            # E o ffmpeg morrer aqui não é raro: elfie_mic_aec é uma source VIRTUAL do
            # module-echo-cancel carregado sem master explícito (ver
            # 51-elfie-echo-cancel.conf), então ela segue os dispositivos default. Quando
            # o PipeWire suspende um device ocioso, ou o default muda, a source virtual é
            # destruída e recriada — e quem estava lendo dela leva EOF.
            bytes_per_block = BLOCK_SIZE * 2
            backoff = 0.5
            silence_block = b'\x00' * bytes_per_block

            _mute_state = {'v': None}  # None força o primeiro log a sempre disparar

            def _should_mute():
                # Ela é audível enquanto o áudio já escrito no ffplay ainda estiver
                # soando (audio_clock) — NÃO enquanto o processo existir.
                now = time.monotonic()
                muted_by_user = self._muted
                muted_by_speech = now < audio_clock['ends_at'] + SPEECH_TAIL_S
                v = muted_by_user or muted_by_speech
                # Loga só nas TRANSIÇÕES, não a cada bloco (seriam ~25/s) — senão o log
                # vira ruído do mesmo jeito que a falta dele era cega.
                if v != _mute_state['v']:
                    _mute_state['v'] = v
                    idbg('mic_gate', muted=v, by_user=muted_by_user, by_speech=muted_by_speech,
                         speech_ends_in_s=round(audio_clock['ends_at'] + SPEECH_TAIL_S - now, 3))
                return v

            def _session_alive():
                return (not session_done.is_set() and not self._stop.is_set()
                        and self._inworld_active.is_set())

            while _session_alive():
                cmd = plat.mic_capture_cmd(SAMPLE_RATE)
                try:
                    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                            **plat.popen_flags())
                except Exception as ex:
                    idbg('mic_open_failed', error=str(ex))
                    print(f'\n[elfie] inworld: falha ao abrir microfone: {ex}', flush=True)
                    return
                mic_proc['p'] = proc
                idbg('mic_opened', pid=proc.pid)

                # stderr NÃO vai mais pra DEVNULL: era por isso que a captura morria em
                # silêncio absoluto. Agora qualquer reclamação do ffmpeg aparece no log.
                def _drain_mic_stderr(p):
                    try:
                        for line in iter(p.stderr.readline, b''):
                            if line.strip():
                                print(f"\n[elfie] mic ffmpeg: {line.decode(errors='replace').strip()}", flush=True)
                    except Exception:
                        pass
                threading.Thread(target=_drain_mic_stderr, args=(proc,), daemon=True,
                                 name='inworld-mic-stderr').start()

                sent_any = self._mic_pump(ws, proc, bytes_per_block, _should_mute,
                                          silence_block, _session_alive)
                idbg('mic_pump_returned', pid=proc.pid, sent_any=sent_any, session_alive=_session_alive())

                try:
                    proc.terminate()
                    proc.wait(timeout=2)
                except Exception:
                    try: proc.kill()
                    except Exception: pass

                if not _session_alive():
                    break
                # Chegou aqui com a sessão ainda viva = a captura caiu sozinha. Reabre.
                idbg('mic_reopening', backoff_s=backoff, sent_any=sent_any)
                print(f'\n[elfie] inworld: captura de microfone caiu, reabrindo em {backoff:.1f}s', flush=True)
                time.sleep(backoff)
                # Backoff só cresce quando a reabertura falha na hora (source sumiu de
                # vez); se chegou a mandar áudio, foi uma queda pontual e o próximo
                # restart volta a ser rápido.
                backoff = 0.5 if sent_any else min(backoff * 2, 5.0)

        def on_open(ws):
            print('\n[elfie] inworld: conectado', flush=True)

        def on_message(ws, message):
            try:
                msg = json.loads(message)
            except Exception:
                return
            mtype = msg.get('type', '')

            # Todo tipo de mensagem, MENOS audio.delta (esse tem log próprio — só
            # começo/fim de rajada, senão seriam dezenas por segundo de linha idêntica).
            if not mtype.endswith('audio.delta'):
                if audio_burst['active']:
                    audio_burst['active'] = False
                    idbg('audio_delta_burst_end', ends_at_delta_s=round(audio_clock['ends_at'] - time.monotonic(), 3))
                # O suporte da Inworld pede Session ID/Execution ID/Span ID pra
                # localizar a interação nos traces deles — a gente nunca logou isso,
                # só o 'type' de cada mensagem. _extract_ids varre o payload inteiro
                # (topo + um nível de aninhamento) atrás de qualquer campo 'id' ou
                # que termine em '_id', sem presumir o nome exato do campo deles.
                ids = _extract_ids(msg)
                idbg('ws_in', mtype=mtype, **ids)

            if mtype == 'elfie.ready':
                self._set_state('listening')
                threading.Thread(target=mic_sender, args=(ws,), daemon=True, name='inworld-mic').start()
                return

            if mtype == 'error':
                # Erro nativo do Inworld vem aninhado em error.{message,code,type}, igual ao
                # protocolo da OpenAI — não é campo message na raiz (isso é só pros erros que
                # o nosso próprio backend sintetiza, ex.: falta INWORLD_API_KEY).
                err = msg.get('error') or {}
                detail = msg.get('message') or err.get('message') or json.dumps(err or msg, ensure_ascii=False)
                idbg('inworld_error', detail=detail)
                print(f'\n[elfie] inworld error: {detail}', flush=True)
                return

            if mtype == 'conversation.item.input_audio_transcription.completed':
                # Novo pedido do usuário = novo "flow" pra fins do cue 'ryo' — não dá pra
                # resetar isso em response.done (tentei, era o bug): a Inworld manda um
                # response.done por RODADA de tool, não um só pro turno inteiro como o
                # pipeline clássico (lá é uma stream SSE contínua até a resposta final).
                # Resetando em response.done, cada tool subsequente no mesmo turno também
                # tocava 'ryo' de novo, em vez de só a primeira.
                tool_flow['started'] = False
                text = (msg.get('transcript') or '').strip()
                idbg('user_transcript', text=text)
                if text:
                    print(f'\n[elfie] inworld (você disse): {text}', flush=True)
                return

            if mtype == 'response.output_audio_transcript.delta':
                assistant_transcript['text'] += msg.get('delta') or ''
                return

            if mtype == 'response.output_audio_transcript.done':
                text = (msg.get('transcript') or assistant_transcript['text']).strip()
                assistant_transcript['text'] = ''
                if text:
                    print(f'\n[elfie] inworld (ela disse): {text}', flush=True)
                return

            # response.output_item.added carrega o nome da tool quando item.type ==
            # 'function_call' — é o único ponto do protocolo onde o nome aparece (os
            # eventos .delta/.done de argumentos, abaixo, só têm call_id). Usa isso pra
            # acender o mesmo cue sonoro/kanji que o pipeline clássico dispara em
            # _process_voice_stream (linha ~688) — antes a Inworld não tocava nem
            # websearch.mp3 nem o cue 'ryo' porque esse evento caía direto no
            # ignore-list abaixo, igual todo o resto do housekeeping do protocolo.
            if mtype == 'response.output_item.added':
                item = msg.get('item') or {}
                if item.get('type') == 'function_call':
                    name = item.get('name') or ''
                    if not tool_flow['started']:
                        tool_flow['started'] = True
                        self._cue_great_sage('ryo')
                    if name == 'web_search':
                        self._play_sfx('websearch.mp3')
                    self._show_tool_activity(name, '')
                return

            if mtype == 'input_audio_buffer.speech_started':
                # Usuário começou a falar de novo — reconsulta a seleção de tela AGORA
                # (não só uma vez no início da chamada) e manda pro servidor injetar como
                # contexto fresco, se for diferente do que já mandamos. _get_selected_text
                # faz subprocess (wl-paste/xsel), roda numa thread separada pra não travar
                # esse handler de mensagem.
                def _refresh_selection():
                    text = _get_selected_text()
                    if text and text != last_selection['text']:
                        last_selection['text'] = text
                        try:
                            ws.send(json.dumps({'type': 'elfie.selection_update', 'text': text}))
                        except Exception:
                            pass
                threading.Thread(target=_refresh_selection, daemon=True, name='selection-refresh').start()
                idbg('speech_started')
                return

            # Housekeeping do protocolo (confirmado em tráfego real 2026-09-04) que não
            # precisa de ação nossa: ciclo de sessão, VAD do lado deles, o eco item-a-item
            # da conversa, e a estrutura da resposta (item/content-part/output_text —
            # já cobrimos o que interessa via audio_transcript acima). Silenciado pra não
            # poluir o log; só o que a gente NÃO reconhece ainda cai no catch-all lá embaixo.
            if mtype in (
                'session.created', 'session.updated',
                'input_audio_buffer.speech_stopped',
                'input_audio_buffer.committed', 'input_audio_buffer.turn_suggestion',
                'conversation.item.added', 'conversation.item.done',
                'conversation.item.input_audio_transcription.delta',
                'response.created', 'response.output_item.done',
                'response.content_part.added', 'response.content_part.done',
                'response.output_text.done', 'response.output_audio.done',
                # Ciclo de tool calling — a execução real acontece no lado do servidor
                # (api/src/inworldRealtime.js), o daemon só ecoa esses eventos sem
                # precisar agir. Adicionados quando web_search/execute_command/etc. e
                # os dynamic skills entraram (2026-09-04) — antes só list_voices/
                # change_voice existiam e quase nunca disparavam esse ciclo.
                'response.function_call_arguments.delta', 'response.function_call_arguments.done',
            ):
                return

            if mtype.endswith('audio.delta') and msg.get('delta'):
                if not audio_burst['active']:
                    audio_burst['active'] = True
                    idbg('audio_delta_burst_start')
                cancel_scheduled_stop()
                self._set_state('speaking')
                # Precisa estar TODO dentro do mesmo lock que stop_playback() usa pra
                # fechar o stdin — antes o write() rodava sem lock nenhum, então mesmo
                # com o debounce/pending_tools no lugar, uma stop_playback() concorrente
                # (outra thread) podia fechar o stdin bem entre o "if p and p.stdin" e o
                # write() — dava exatamente esse "write to closed file" mesmo com tudo
                # certo em teoria. _play_lock é RLock justamente pra start_playback()
                # (chamado aqui dentro) poder pegar o lock de novo sem travar.
                with self._play_lock:
                    p = play_proc['p']
                    # Chunk novo com o player anterior já fechado (closing) ou morto: é
                    # fala NOVA começando antes da anterior acabar de tocar. O caso
                    # 'closing' é o que quebrava tudo — o processo ainda está vivo
                    # (poll() is None) e audível, então a checagem antiga só por
                    # poll() caía direto no write() de um stdin fechado, estourava a
                    # exceção lá embaixo, largava o processo antigo tocando sozinho e
                    # abria um segundo ffplay no chunk seguinte. Mata o anterior antes.
                    if p is not None and (play_proc['closing'] or p.poll() is not None):
                        kill_playback_now('fala nova antes da anterior terminar')
                        p = None
                    if p is None:
                        start_playback()
                    try:
                        chunk = base64.b64decode(msg['delta'])
                        p = play_proc['p']
                        if p and p.stdin:
                            p.stdin.write(chunk)
                            p.stdin.flush()
                            # Avança o relógio de fala pelo tempo REAL que este chunk
                            # representa. max(..., now) trata a lacuna entre respostas:
                            # se o áudio anterior já terminou, conta a partir de agora.
                            audio_clock['ends_at'] = (
                                max(audio_clock['ends_at'], time.monotonic())
                                + len(chunk) / OUTPUT_BYTES_PER_SEC
                            )
                    except Exception as ex:
                        # Antes isso sumia em silêncio — o texto (transcript) chega por um
                        # evento totalmente separado do áudio, então uma resposta podia
                        # aparecer completa no log enquanto o som cortava no meio sem
                        # nenhum aviso. Loga e derruba o player de verdade: só zerar o
                        # handle (como era antes) deixava o processo vivo tocando enquanto
                        # o gate do mic reabria na hora — autoescuta garantida.
                        print(f'\n[elfie] inworld: falha ao escrever áudio no ffplay: {ex}', flush=True)
                        kill_playback_now('erro de escrita no ffplay')
                return

            if mtype == 'response.done':
                # NÃO chama stop_playback()/schedule diretamente, e NÃO reseta
                # tool_flow['started'] — a Inworld manda response.done uma vez por RODADA de
                # tool, não uma vez pro turno inteiro (confirmado ao vivo). on_response_done()
                # só agenda o fechamento se nenhuma tool estiver realmente em voo agora (ver
                # elfie.tool_executing/elfie.tool_result_submitted abaixo) — senão fica
                # pendente até a última tool em voo terminar. tool_flow reseta em
                # conversation.item.input_audio_transcription.completed.
                self._clear_tool_activity()
                on_response_done()
                return

            if mtype == 'elfie.tool_executing':
                # Servidor avisa que uma tool está executando de verdade AGORA (pode ser
                # request HTTP real — web_fetch, test_skill — levando vários segundos).
                # Cancela qualquer fechamento agendado: sabemos que mais áudio vem depois.
                pending_tools['count'] += 1
                idbg('tool_executing', tool=msg.get('name'), pending_tools=pending_tools['count'])
                cancel_scheduled_stop()
                return

            if mtype == 'elfie.tool_result_submitted':
                pending_tools['count'] = max(0, pending_tools['count'] - 1)
                idbg('tool_result_submitted', tool=msg.get('name'), pending_tools=pending_tools['count'],
                     response_done_pending=response_done_pending['v'])
                if pending_tools['count'] == 0 and response_done_pending['v']:
                    response_done_pending['v'] = False
                    schedule_stop_playback()
                return

            print(f'[elfie] inworld: evento não tratado: {mtype}', flush=True)

        def on_error(ws, error):
            idbg('ws_error', error=str(error))
            print(f'\n[elfie] inworld ws error: {error}', flush=True)

        def on_close(ws, *_args):
            idbg('ws_close')
            session_done.set()

        ws_app = websocket.WebSocketApp(
            ws_url, on_open=on_open, on_message=on_message, on_error=on_error, on_close=on_close,
        )

        try:
            # ping_timeout mais folgado (era 10s): o servidor agora manda ping ativo a
            # cada 12s dos dois lados (ver HEARTBEAT_MS em inworldRealtime.js) — suspeita
            # forte de que era a Inworld (ou algo no meio do caminho) derrubando por
            # inatividade durante uma tool call real (web_fetch/test_skill podem levar
            # até ~15s numa API de verdade), o que em cascata matava essa conexão
            # também. Isso é margem de segurança extra, não a correção principal.
            ws_app.run_forever(ping_interval=25, ping_timeout=15)
        finally:
            session_done.set()
            # Antes do stop_playback() abaixo: com o fechamento agora agendado pro fim
            # real do áudio, um timer pendente pode ser bem longo, e ele dispararia
            # depois que a sessão já acabou (mexendo em estado/overlay de uma ligação
            # que não existe mais).
            cancel_scheduled_stop()
            p = mic_proc['p']
            if p and p.poll() is None:
                try:
                    p.terminate()
                    p.wait(timeout=2)
                except Exception:
                    try: p.kill()
                    except Exception: pass
            stop_playback()
            # stop_playback() só AGENDA o fechamento (thread reaper assíncrona) — sem
            # esperar de verdade aqui, uma reconexão rápida (comum logo depois de um
            # "ping/pong timed out") podia começar a sessão SEGUINTE enquanto o ffplay
            # da sessão anterior ainda tava tocando/segurando o sink de AEC, ou com
            # play_proc ainda não limpo — um dos jeitos reais dela acabar se escutando
            # bem na hora de uma reconexão. Espera até ~3s o reaper terminar antes de
            # devolver o controle pro _inworld_loop reconectar.
            for _ in range(60):
                if play_proc['p'] is None:
                    break
                time.sleep(0.05)

    def _play_sfx(self, filename: str, volume: float = 1.0):
        path = Path(__file__).parent / filename
        if not path.exists():
            return
        scale = int(32768 * max(0.0, min(1.0, volume)))
        def _run():
            try:
                subprocess.Popen(
                    plat.mp3_play_cmd(path, volume=volume),
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    **plat.popen_flags(),
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
                    plat.mp3_play_cmd(path, volume=0.5, loop=True),
                    stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                    **plat.popen_flags(),
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
                    plat.interrupt_process(session['proc'])
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

            session_dir = plat.session_dir(f'neuro-{chat_id}')
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
                # Grupo próprio no Windows: sem isso o CTRL_BREAK do
                # interrupt_process() não tem como chegar só nele.
                **plat.new_process_group(),
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
            plat.interrupt_process(session['proc'])
            print(f'\n[neuro:{chat_id[:8]}] interrupção enviada', flush=True)
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
                cwd=str(plat.runtime_dir()),
                **plat.new_process_group(),
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

    def _on_hotkey_f9(self):
        if not self._muted:
            self._stop_playback()
        self._toggle_mute()
        self._play_sfx('toggle.mp3', volume=0.6)

    def _on_hotkey_f7(self):
        self._interrupt_response()

    def _hotkey_loop(self):
        backend = plat.hotkey_backend()

        if backend == 'win32':
            plat.run_windows_hotkeys(
                {'F9': self._on_hotkey_f9, 'F7': self._on_hotkey_f7},
                lambda: self._stop.is_set(),
            )
            return

        if backend != 'evdev':
            print('\n[elfie] sem backend de hotkey nesta plataforma — F9/F7 desabilitados',
                  flush=True)
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
                                self._on_hotkey_f9()
                            elif event.code == ecodes.KEY_F7:
                                self._on_hotkey_f7()
                except Exception:
                    pass

        for dev in keyboards:
            try:
                dev.close()
            except Exception:
                pass

    def _ipc_loop(self):
        srv = plat.create_ipc_server(5)
        srv.settimeout(1.0)
        print(f'[elfie] IPC escutando em {plat.ipc_address_label()}', flush=True)

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

        if action == 'great_sage_cue':
            cue = cmd.get('cue', '').strip()
            if cue not in self._GREAT_SAGE_CUES:
                return {'error': f'cue desconhecida: {cue}'}
            self._cue_great_sage(cue)
            return {'ok': True}

        if action == 'skill_evolution':
            line = cmd.get('line', '').strip()
            skill_name = cmd.get('skillName', '').strip()
            if self._great_sage_enabled():
                self._play_sfx('warning.mp3')  # 告 (KOKU) — toca já no início do beat de abertura
            threading.Thread(
                target=self._spawn_skill_evolution_overlay,
                args=(line, skill_name),
                daemon=True,
                name='skill-evolution-overlay',
            ).start()
            return {'ok': True}

        if action == 'skill_evolution_resolve':
            skill_name = cmd.get('skillName', '').strip()
            success = bool(cmd.get('success', True))
            # Ainda usando ryo.mp3 pro beat de fechamento (是/ZE) — não existe ze.mp3
            # dedicado. Dispara exatamente quando test_skill de fato confirma sucesso
            # (ver forge_skill/test_skill em chats.controller.js e inworldRealtime.js),
            # não num timer chutado — o loop de teste pode levar segundos ou minutos.
            if self._great_sage_enabled():
                self._play_sfx('ryo.mp3')
            self._resolve_skill_evolution(skill_name, success)
            return {'ok': True}

        if action == 'skill_evolution_status':
            line = cmd.get('line', '').strip()
            kanji = cmd.get('kanji', '').strip()
            self._update_skill_evolution_status(line, kanji)
            return {'ok': True}

        if action == 'skill_evolution_notice':
            line = cmd.get('line', '').strip()
            if self._great_sage_enabled():
                self._play_sfx('warning.mp3')  # 告 (KOKU), same cue as forge_skill's opening beat
            self._notice_skill_evolution(line)
            return {'ok': True}

        if action == 'skill_evolution_failure':
            line = cmd.get('line', '').strip()
            skill_name = cmd.get('skillName', '').strip()
            # Sem asset de som dedicado a erro — neurooff.mp3 já soa como "algo parou/
            # abortou", encaixa melhor que reusar ryo/warning aqui.
            if self._great_sage_enabled():
                self._play_sfx('neurooff.mp3')
            self._fail_skill_evolution(line, skill_name)
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
            threading.Thread(target=self._inworld_loop,       daemon=True, name='inworld'),
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
        plat.cleanup_ipc()


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
    print(f'[elfie] ipc:    {plat.ipc_address_label()}')
    print(f'[elfie] ambiente: {plat.describe_environment()}')

    for tool in ('ffmpeg', 'ffplay'):
        if not plat.which(tool):
            print(f'[elfie] AVISO: {tool} não está no PATH — áudio não vai funcionar.')
    if plat.hotkey_backend() == 'none':
        print('[elfie] AVISO: sem backend de hotkey — F9/F7 desabilitados.')
    if not plat.has_echo_cancellation():
        print('[elfie] nota: sem cancelamento de eco do sistema nesta plataforma; '
              'usando só o gate por software (use fone pra evitar que ela se ouça).')
    print()

    ElfieDaemon().run()


if __name__ == '__main__':
    main()