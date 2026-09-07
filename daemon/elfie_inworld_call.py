#!/usr/bin/env python3
"""Sessão de chamada Inworld S2S (voz full-duplex) — implementação nova,
separada de elfie_daemon.py, escrita do zero em 2026-09-04 a pedido explícito
do usuário depois de várias rodadas de patch incremental em cima da versão
antiga (ElfieDaemon._run_inworld_session — continua no arquivo original,
INTOCADA, só parou de ser chamada por _inworld_loop) que foram empilhando
complexidade sem resolver os sintomas reais: fala sobreposta, mic "surdo"
depois de tool call, e turnos que morrem depois de turn_suggestion sem nunca
virar resposta.

Duas causas raiz REAIS foram confirmadas com log de verdade (INWORLD_DEBUG=1
na versão antiga, sessão de debug ao vivo em 2026-09-04) antes desta reescrita:
  1. session.update mandava turn_detection sem create_response/
     interrupt_response explícitos — já corrigido no SERVIDOR
     (api/src/inworldRealtime.js), continua valendo pra esta versão também
     (o daemon nunca monta esse payload, quem manda é o servidor).
  2. Ganho de entrada do mic estava ~31dB acima do unity gain do hardware,
     causando clipping no áudio antes mesmo de sair da placa — ajuste de
     sistema (pactl), fora do escopo deste arquivo.

O que muda aqui não é "mais um patch": é simplificar a arquitetura da
ligação em vez de empilhar remendo em cima de remendo:

  - UM SÓ processo ffplay para a ligação inteira, não um por resposta.
    Elimina de raiz toda a categoria de bug "processo antigo ainda tocando
    enquanto um novo abre no meio" (a causa real da fala sobreposta na
    versão antiga) — nunca existe um "processo novo" no meio da ligação,
    só ao FIM dela. Se ele morrer (crash, ou F7 matando via
    daemon._stop_playback(), que ainda mira nesse mesmo processo — ver
    _Playback.write), a PRÓXIMA escrita simplesmente abre outro.

  - UM SÓ processo ffmpeg de captura, supervisionado: se cair, reabre
    sozinho. elfie_mic_aec é uma source VIRTUAL do module-echo-cancel sem
    master explícito — ela pode sumir/recriar quando o PipeWire suspende
    um device ocioso, e isso não é raro. Uma captura que morre e nunca
    reabre é "ela parou de me escutar do nada" sem nenhum erro visível.

  - O relógio de "até quando ela ainda está audível" é só aritmética sobre
    BYTES ESCRITOS no player (o formato de saída é fixo, então o tempo de
    áudio de cada chunk é exato) — não fica lendo poll()/estado de
    processo pra adivinhar se ela está falando, que foi a causa real do
    mic ficar mudo the tool call inteira na versão antiga (o ffplay fica
    vivo e ocioso de propósito enquanto uma tool roda).

  - Watchdog de turno: se ela começa a falar (speech_started) e não chega
    nem transcrição nem resposta em TURN_STALL_WARN_S segundos, isso é
    logado como aviso alto e inconfundível, tanto no arquivo de debug
    quanto no terminal. Decidir se é bug daqui ou travamento do lado da
    Inworld não pode mais exigir uma sessão inteira de arqueologia de log
    pra descobrir — o sintoma fica óbvio na hora que acontece.

Módulo AUTOCONTIDO de propósito: não importa nada de elfie_daemon.py (evita
import circular e mantém as duas implementações genuinamente independentes,
uma não quebra se a outra mudar). Só recebe `daemon` — a instância
ElfieDaemon viva — e usa dela só os pedaços que já existem e funcionam bem
(overlay, cues sonoros de personagem, estado, o handle de playback
compartilhado com F7) porque essas partes nunca tiveram nada a ver com os
bugs relatados.
"""

import base64
import json
import os
import subprocess
import threading
import time
from pathlib import Path
from urllib.parse import quote

import numpy as np
import requests
import websocket

import platform_compat as plat

# --- Constantes de áudio ------------------------------------------------------
SAMPLE_RATE = 16000                              # entrada: mic -> Inworld
BLOCK_MS = 30
BLOCK_SIZE = int(SAMPLE_RATE * BLOCK_MS / 1000)  # 480 amostras = 30ms
OUTPUT_SAMPLE_RATE = 24000                       # saída: Inworld -> alto-falante
OUTPUT_BYTES_PER_SEC = OUTPUT_SAMPLE_RATE * 2    # PCM16 mono

# Banda de voz (300-3400Hz) pro medidor de energia que alimenta o VU do overlay —
# mesmos parâmetros que o resto do daemon usa pro pipeline clássico, só duplicado
# aqui (função pura de SAMPLE_RATE/BLOCK_SIZE) pra este módulo não depender de
# importar elfie_daemon.py.
_FFT_N = BLOCK_SIZE * 2
_BIN_HZ = SAMPLE_RATE / _FFT_N
_LO_BIN = max(1, int(300 / _BIN_HZ))
_HI_BIN = int(3400 / _BIN_HZ)

SPEECH_TAIL_S = 0.25          # margem depois do último byte de áudio escrito
STOP_DEBOUNCE_S = 0.6         # só bookkeeping de estado/overlay — não mexe no player
MIC_REOPEN_BACKOFF_MAX_S = 5.0
TURN_STALL_WARN_S = 12.0      # sem resolução depois de speech_started -> alerta
MAX_SELECTED_TEXT_CHARS = 6000

INWORLD_WS_PING_INTERVAL_S = 25
INWORLD_WS_PING_TIMEOUT_S = 15

DEBUG = os.environ.get('INWORLD_CALL_DEBUG') == '1' or os.environ.get('INWORLD_DEBUG') == '1'
DEBUG_LOG_PATH = Path(__file__).parent / 'inworld_call_debug.log'
_debug_lock = threading.Lock()


def _dbg(tag: str, **fields):
    """Log diagnóstico deste módulo — arquivo PRÓPRIO (inworld_call_debug.log),
    separado do log da implementação antiga, pra nunca misturar dado das duas.
    Ligado via INWORLD_CALL_DEBUG=1 ou INWORLD_DEBUG=1 (aceita os dois pra não
    quebrar o hábito já formado); no-op se nenhum dos dois estiver setado."""
    if not DEBUG:
        return
    ts = time.strftime('%H:%M:%S', time.localtime()) + f'.{int(time.time() * 1000) % 1000:03d}'
    parts = ' '.join(f'{k}={v!r}' for k, v in fields.items())
    try:
        with _debug_lock:
            with open(DEBUG_LOG_PATH, 'a') as f:
                f.write(f'{ts} [{tag}] {parts}\n')
    except Exception:
        pass  # log nunca pode derrubar a ligação


def _get_selected_text() -> str:
    return plat.get_selected_text(MAX_SELECTED_TEXT_CHARS)


def _speech_energy(block: np.ndarray) -> float:
    if block.size == 0:
        return 0.0
    spec = np.abs(np.fft.rfft(block, n=_FFT_N))
    return float(spec[_LO_BIN:_HI_BIN + 1].mean())


class _Playback:
    """Um processo ffplay por CHAMADA (não um por resposta — essa era a raiz da
    fala sobreposta na versão antiga). Nasce sob demanda no primeiro chunk de
    áudio, some só quando a chamada termina — ou se morrer no meio (crash, ou
    F7 via daemon._stop_playback(), que mira no mesmo daemon._play_proc que
    este objeto mantém atualizado), caso em que a PRÓXIMA escrita abre outro
    sem drama nenhum, porque nunca precisamos coordenar "matar o antigo antes
    de abrir o novo" — só existe "o atual", e se ele já morreu, abrimos outro."""

    def __init__(self, daemon):
        self.daemon = daemon
        self.proc = None
        self.ends_at = 0.0  # monotonic: até quando o áudio já escrito ainda soa

    def _spawn(self):
        # No Linux isso injeta o PULSE_SINK do sink com AEC que o mic_sender
        # monitora; nas outras plataformas volta o ambiente sem alteração.
        env = plat.playback_env()
        try:
            proc = subprocess.Popen(
                plat.playback_cmd(OUTPUT_SAMPLE_RATE),
                stdin=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
                **plat.popen_flags(),
            )
        except Exception as ex:
            _dbg('playback_spawn_failed', error=str(ex))
            print(f'\n[elfie] inworld: falha ao iniciar playback: {ex}', flush=True)
            return None
        _dbg('playback_spawned', pid=proc.pid)

        def _drain_stderr(p):
            try:
                for line in iter(p.stderr.readline, b''):
                    if line.strip():
                        print(f"\n[elfie] ffplay: {line.decode(errors='replace').strip()}", flush=True)
            except Exception:
                pass
        threading.Thread(target=_drain_stderr, args=(proc,), daemon=True,
                          name='inworld-ffplay-stderr').start()

        self.proc = proc
        with self.daemon._play_lock:
            self.daemon._play_proc = proc
        return proc

    def write(self, chunk: bytes):
        with self.daemon._play_lock:
            p = self.proc
            if p is None or p.poll() is not None:
                p = self._spawn()
                if p is None:
                    return
            try:
                p.stdin.write(chunk)
                p.stdin.flush()
                now = time.monotonic()
                self.ends_at = max(self.ends_at, now) + len(chunk) / OUTPUT_BYTES_PER_SEC
            except Exception as ex:
                _dbg('playback_write_failed', error=str(ex))
                print(f'\n[elfie] inworld: falha ao escrever áudio no ffplay: {ex}', flush=True)
                try:
                    p.kill()
                except Exception:
                    pass
                self.proc = None
                with self.daemon._play_lock:
                    if self.daemon._play_proc is p:
                        self.daemon._play_proc = None

    def is_audible(self) -> bool:
        return time.monotonic() < self.ends_at + SPEECH_TAIL_S

    def close(self):
        """Fim da CHAMADA (não de uma resposta) — fecha o stdin, deixa o
        -autoexit drenar o que sobrou e sair sozinho. Espera até ~3s pra
        realmente terminar antes de devolver — uma reconexão rápida logo
        depois (ping/pong timeout, por exemplo) não pode começar enquanto o
        player antigo ainda segura o sink de AEC."""
        with self.daemon._play_lock:
            p = self.proc
            self.proc = None
            if self.daemon._play_proc is p:
                self.daemon._play_proc = None
        if not p:
            return
        try:
            p.stdin.close()
        except Exception:
            pass
        done = threading.Event()

        def _reap():
            try:
                p.wait(timeout=10)
            except Exception:
                try:
                    p.terminate()
                    p.wait(timeout=3)
                except Exception:
                    try:
                        p.kill()
                    except Exception:
                        pass
            done.set()
        threading.Thread(target=_reap, daemon=True, name='inworld-ffplay-reap').start()
        done.wait(timeout=3)


class _MicCapture:
    """Captura supervisionada de elfie_mic_aec -> stream contínuo de blocos
    PCM16 mono pro websocket. 'Contínuo' é a parte que importa: quando não é
    pra mandar áudio de verdade (mudo, ou ela ainda audível), manda SILÊNCIO
    em vez de pular o bloco — pular picotava a linha do tempo que a Inworld
    recebe, e áudio picotado é receita pra STT alucinar frase que ninguém
    falou (confirmado: era exatamente isso que produzia "嗯"/"Ah" fantasma na
    versão antiga antes desse ajuste)."""

    def __init__(self, daemon, ws, should_mute):
        self.daemon = daemon
        self.ws = ws
        self.should_mute = should_mute
        self.bytes_per_block = BLOCK_SIZE * 2
        self.silence = b'\x00' * self.bytes_per_block
        self.current_proc = None  # pra quem chamou poder matar no fim da sessão

    def run(self, session_alive):
        backoff = 0.5
        while session_alive():
            proc = self._open()
            if proc is None:
                return
            self.current_proc = proc
            sent_any = self._pump(proc, session_alive)
            self._terminate(proc)
            self.current_proc = None
            if not session_alive():
                return
            _dbg('mic_reopening', backoff_s=backoff, sent_any=sent_any)
            print(f'\n[elfie] inworld: captura de microfone caiu, reabrindo em {backoff:.1f}s', flush=True)
            time.sleep(backoff)
            # Só cresce quando nem consegue mandar nada (source sumiu de vez);
            # uma queda pontual que já mandou áudio volta rápido.
            backoff = 0.5 if sent_any else min(backoff * 2, MIC_REOPEN_BACKOFF_MAX_S)

    def _open(self):
        cmd = plat.mic_capture_cmd(SAMPLE_RATE)
        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    **plat.popen_flags())
        except Exception as ex:
            _dbg('mic_open_failed', error=str(ex))
            print(f'\n[elfie] inworld: falha ao abrir microfone: {ex}', flush=True)
            return None
        _dbg('mic_opened', pid=proc.pid)

        def _drain(p):
            try:
                for line in iter(p.stderr.readline, b''):
                    if line.strip():
                        print(f"\n[elfie] mic ffmpeg: {line.decode(errors='replace').strip()}", flush=True)
            except Exception:
                pass
        threading.Thread(target=_drain, args=(proc,), daemon=True, name='inworld-mic-stderr').start()
        return proc

    def _pump(self, proc, session_alive) -> bool:
        sent_any = False
        last_gate = None  # só loga TRANSIÇÃO, não cada bloco (seriam ~33/s)
        while session_alive():
            raw = proc.stdout.read(self.bytes_per_block)
            if not raw or len(raw) < self.bytes_per_block:
                return sent_any  # EOF: ffmpeg morreu, quem chamou reabre
            mute = self.should_mute()
            if mute != last_gate:
                last_gate = mute
                _dbg('mic_gate', muted=mute)
            if mute:
                raw = self.silence
            if self.daemon._start_thr > 0:
                block = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
                self.daemon._send_energy_to_overlay(
                    min(1.0, _speech_energy(block) / self.daemon._start_thr))
            try:
                self.ws.send(json.dumps({
                    'type': 'input_audio_buffer.append',
                    'audio': base64.b64encode(raw).decode('ascii'),
                }))
                sent_any = True
            except Exception:
                return sent_any  # websocket caiu — a sessão inteira vai perceber
        return sent_any

    @staticmethod
    def _terminate(proc):
        try:
            proc.terminate()
            proc.wait(timeout=2)
        except Exception:
            try:
                proc.kill()
            except Exception:
                pass


def run_inworld_call(daemon, api: str):
    """Ponto de entrada — chamado por ElfieDaemon._inworld_loop() no lugar da
    implementação antiga. Mesma assinatura de efeito (bloqueia até a ligação
    acabar) pra a troca no daemon ser de uma linha só."""
    ws_url = api.replace('https://', 'wss://').replace('http://', 'ws://') + '/ws/inworld-call'
    # Snapshot inicial da seleção de tela, igual à versão antiga — cobre "liguei
    # já olhando pra algo". Atualizações seguintes vêm de speech_started abaixo.
    selected_text = _get_selected_text()
    if selected_text:
        ws_url += '?selectedText=' + quote(selected_text)

    _dbg('session_start', api=api)

    session_done = threading.Event()
    last_selection = {'text': selected_text}
    playback = _Playback(daemon)
    mic = None  # criado em elfie.ready, quando sabemos que a sessão pegou

    pending_tools = {'count': 0}
    tool_flow_started = {'v': False}
    assistant_transcript = {'text': ''}
    finalize_timer = {'t': None}
    turn = {'awaiting': False, 'since': 0.0, 'warned': False}

    def session_alive():
        return not session_done.is_set() and not daemon._stop.is_set() and daemon._inworld_active.is_set()

    def should_mute():
        return daemon._muted or playback.is_audible()

    def cancel_finalize():
        if finalize_timer['t']:
            finalize_timer['t'].cancel()
            finalize_timer['t'] = None

    def do_finalize():
        daemon._clear_tool_activity()
        if not daemon._muted:
            daemon._set_state('listening')

    def schedule_finalize():
        cancel_finalize()
        finalize_timer['t'] = threading.Timer(STOP_DEBOUNCE_S, do_finalize)
        finalize_timer['t'].start()

    def on_response_done():
        # A Inworld manda response.done uma vez por RODADA de tool, não uma vez
        # pro turno inteiro — só finaliza (limpa overlay, volta pro estado
        # listening) quando NENHUMA tool está de fato em voo agora.
        if pending_tools['count'] > 0:
            return
        schedule_finalize()

    def mark_turn_started():
        turn['awaiting'] = True
        turn['since'] = time.monotonic()
        turn['warned'] = False

    def mark_turn_resolved():
        turn['awaiting'] = False
        turn['warned'] = False

    def _turn_watchdog():
        while session_alive():
            time.sleep(2)
            if turn['awaiting'] and not turn['warned'] and \
                    time.monotonic() - turn['since'] > TURN_STALL_WARN_S:
                turn['warned'] = True
                elapsed = time.monotonic() - turn['since']
                print(f'\n[elfie] inworld: ATENÇÃO — turno sem resposta há {elapsed:.0f}s '
                      f'desde que você começou a falar (se turn_suggestion chegou e nada mais '
                      f'depois disso, é travamento do lado da Inworld, não do daemon)', flush=True)
                _dbg('turn_stall_warning', elapsed_s=round(elapsed, 1))
    threading.Thread(target=_turn_watchdog, daemon=True, name='inworld-turn-watchdog').start()

    def on_open(ws):
        print('\n[elfie] inworld: conectado', flush=True)

    def on_message(ws, message):
        try:
            msg = json.loads(message)
        except Exception:
            return
        mtype = msg.get('type', '')

        if not mtype.endswith('audio.delta'):
            _dbg('ws_in', mtype=mtype)

        if mtype == 'elfie.ready':
            nonlocal mic
            daemon._set_state('listening')
            mic = _MicCapture(daemon, ws, should_mute)
            threading.Thread(target=mic.run, args=(session_alive,), daemon=True,
                              name='inworld-mic').start()
            return

        if mtype == 'error':
            err = msg.get('error') or {}
            detail = msg.get('message') or err.get('message') or json.dumps(err or msg, ensure_ascii=False)
            _dbg('inworld_error', detail=detail)
            print(f'\n[elfie] inworld error: {detail}', flush=True)
            return

        if mtype == 'conversation.item.input_audio_transcription.completed':
            tool_flow_started['v'] = False
            mark_turn_resolved()
            text = (msg.get('transcript') or '').strip()
            _dbg('user_transcript', text=text)
            if text:
                print(f'\n[elfie] inworld (você disse): {text}', flush=True)
            return

        if mtype == 'response.output_audio_transcript.delta':
            mark_turn_resolved()
            assistant_transcript['text'] += msg.get('delta') or ''
            return

        if mtype == 'response.output_audio_transcript.done':
            text = (msg.get('transcript') or assistant_transcript['text']).strip()
            assistant_transcript['text'] = ''
            if text:
                print(f'\n[elfie] inworld (ela disse): {text}', flush=True)
            return

        if mtype == 'response.output_item.added':
            item = msg.get('item') or {}
            if item.get('type') == 'function_call':
                name = item.get('name') or ''
                if not tool_flow_started['v']:
                    tool_flow_started['v'] = True
                    daemon._cue_great_sage('ryo')
                if name == 'web_search':
                    daemon._play_sfx('websearch.mp3')
                daemon._show_tool_activity(name, '')
            return

        if mtype == 'input_audio_buffer.speech_started':
            mark_turn_started()

            def _refresh_selection():
                text = _get_selected_text()
                if text and text != last_selection['text']:
                    last_selection['text'] = text
                    try:
                        ws.send(json.dumps({'type': 'elfie.selection_update', 'text': text}))
                    except Exception:
                        pass
            threading.Thread(target=_refresh_selection, daemon=True, name='selection-refresh').start()
            return

        if mtype in (
            'session.created', 'session.updated',
            'input_audio_buffer.speech_stopped',
            'input_audio_buffer.committed', 'input_audio_buffer.turn_suggestion',
            'input_audio_buffer.turn_suggestion_revoked',
            'conversation.item.added', 'conversation.item.done',
            'conversation.item.input_audio_transcription.delta',
            'response.created', 'response.output_item.done',
            'response.content_part.added', 'response.content_part.done',
            'response.output_text.done', 'response.output_audio.done',
            'response.function_call_arguments.delta', 'response.function_call_arguments.done',
        ):
            return

        if mtype.endswith('audio.delta') and msg.get('delta'):
            mark_turn_resolved()
            daemon._set_state('speaking')
            try:
                chunk = base64.b64decode(msg['delta'])
            except Exception:
                return
            playback.write(chunk)
            return

        if mtype == 'response.done':
            daemon._clear_tool_activity()
            on_response_done()
            return

        if mtype == 'elfie.tool_executing':
            pending_tools['count'] += 1
            cancel_finalize()
            return

        if mtype == 'elfie.tool_result_submitted':
            pending_tools['count'] = max(0, pending_tools['count'] - 1)
            if pending_tools['count'] == 0:
                schedule_finalize()
            return

        print(f'[elfie] inworld: evento não tratado: {mtype}', flush=True)

    def on_error(ws, error):
        _dbg('ws_error', error=str(error))
        print(f'\n[elfie] inworld ws error: {error}', flush=True)

    def on_close(ws, *_args):
        _dbg('ws_close')
        session_done.set()

    ws_app = websocket.WebSocketApp(
        ws_url, on_open=on_open, on_message=on_message, on_error=on_error, on_close=on_close,
    )

    try:
        ws_app.run_forever(ping_interval=INWORLD_WS_PING_INTERVAL_S,
                            ping_timeout=INWORLD_WS_PING_TIMEOUT_S)
    finally:
        cancel_finalize()
        session_done.set()
        if mic is not None and mic.current_proc is not None:
            _MicCapture._terminate(mic.current_proc)
        playback.close()
        _dbg('session_end')
