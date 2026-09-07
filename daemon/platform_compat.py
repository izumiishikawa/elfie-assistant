#!/usr/bin/env python3
"""Camada de compatibilidade de plataforma do daemon.

Tudo que depende de sistema operacional mora aqui: caminhos, IPC, controle de
processo, áudio, clipboard e hotkey global. O resto do daemon importa daqui e
não checa sys.platform em lugar nenhum.

No Linux o comportamento é EXATAMENTE o de antes — mesmos caminhos (/tmp/elfie.sock,
/tmp/elfie.pid, ~/.config/elfie), mesmos comandos, mesmo AEC do PipeWire. O port pro
Windows é aditivo: nada do caminho Linux mudou de lugar.
"""

from __future__ import annotations

import os
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

IS_WINDOWS = sys.platform == 'win32'
IS_MACOS = sys.platform == 'darwin'
IS_LINUX = not IS_WINDOWS and not IS_MACOS

PLATFORM_NAME = 'windows' if IS_WINDOWS else ('macos' if IS_MACOS else 'linux')


# ─────────────────────────────────────────────────────────────── caminhos ────

def config_dir() -> Path:
    """Onde fica daemon.json."""
    if IS_WINDOWS:
        base = os.environ.get('APPDATA') or (Path.home() / 'AppData' / 'Roaming')
        return Path(base) / 'elfie'
    return Path.home() / '.config' / 'elfie'


def runtime_dir() -> Path:
    """Arquivos efêmeros (pid, porta, sessões). No Linux continua sendo /tmp puro."""
    if IS_WINDOWS:
        d = Path(tempfile.gettempdir()) / 'elfie'
        d.mkdir(parents=True, exist_ok=True)
        return d
    return Path('/tmp')


def data_dir() -> Path:
    """~/.elfie — knowledge, lancedb, backups. Igual nos dois."""
    return Path.home() / '.elfie'


CONFIG_PATH = config_dir() / 'daemon.json'
PID_PATH = str(runtime_dir() / 'elfie.pid')

# No Windows não dá pra confiar em AF_UNIX (suporte irregular no Python), então o
# IPC vira TCP no loopback e a porta escolhida é publicada neste arquivo pro
# cliente (a API em Node) descobrir.
SOCK_PATH = str(runtime_dir() / 'elfie.sock') if not IS_WINDOWS else None
PORT_PATH = str(runtime_dir() / 'elfie.port')
DEFAULT_TCP_PORT = 41907


def session_dir(name: str) -> Path:
    return runtime_dir() / name


# ─────────────────────────────────────────────────────────── subprocessos ────

def popen_flags() -> dict:
    """Impede que cada ffmpeg/ffplay abra uma janela de console preta no Windows."""
    if IS_WINDOWS:
        return {
            'creationflags': getattr(subprocess, 'CREATE_NO_WINDOW', 0x08000000),
        }
    return {}


def which(name: str) -> str | None:
    import shutil
    return shutil.which(name) or (shutil.which(name + '.exe') if IS_WINDOWS else None)


def kill_pid(pid: int, force: bool = False) -> None:
    """SIGTERM/SIGKILL no POSIX; TerminateProcess no Windows (os.kill mapeia pra isso)."""
    import signal as _signal
    if IS_WINDOWS:
        # No Windows os.kill só entende CTRL_*_EVENT; qualquer outro valor vira
        # TerminateProcess, que é o que a gente quer nos dois casos.
        os.kill(pid, _signal.SIGTERM)
        return
    os.kill(pid, _signal.SIGKILL if force else _signal.SIGTERM)


def pid_alive(pid: int) -> bool:
    if IS_WINDOWS:
        # os.kill(pid, 0) não funciona como sonda no Windows — usa OpenProcess.
        import ctypes
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        STILL_ACTIVE = 259
        h = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not h:
            return False
        try:
            code = ctypes.c_ulong()
            ok = ctypes.windll.kernel32.GetExitCodeProcess(h, ctypes.byref(code))
            return bool(ok) and code.value == STILL_ACTIVE
        finally:
            ctypes.windll.kernel32.CloseHandle(h)
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


# ──────────────────────────────────────────────────────────────────── IPC ────

def create_ipc_server(backlog: int = 5) -> socket.socket:
    """Socket de escuta do daemon. AF_UNIX no POSIX, TCP loopback no Windows."""
    if IS_WINDOWS:
        srv = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        port = int(os.environ.get('ELFIE_DAEMON_PORT') or DEFAULT_TCP_PORT)
        try:
            srv.bind(('127.0.0.1', port))
        except OSError:
            srv.bind(('127.0.0.1', 0))  # porta livre qualquer
            port = srv.getsockname()[1]
        srv.listen(backlog)
        # Publica a porta pra API achar o daemon sem precisar adivinhar.
        Path(PORT_PATH).write_text(str(port), encoding='utf-8')
        return srv

    if os.path.exists(SOCK_PATH):
        os.unlink(SOCK_PATH)
    srv = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    srv.bind(SOCK_PATH)
    srv.listen(backlog)
    return srv


def ipc_address_label() -> str:
    if IS_WINDOWS:
        try:
            return f'127.0.0.1:{Path(PORT_PATH).read_text().strip()}'
        except OSError:
            return f'127.0.0.1:{DEFAULT_TCP_PORT}'
    return SOCK_PATH


def cleanup_ipc() -> None:
    for p in ([PORT_PATH] if IS_WINDOWS else [SOCK_PATH]):
        try:
            os.unlink(p)
        except OSError:
            pass


def connect_ipc(timeout: float = 5.0) -> socket.socket:
    """Cliente Python (usado por scripts auxiliares)."""
    if IS_WINDOWS:
        try:
            port = int(Path(PORT_PATH).read_text().strip())
        except (OSError, ValueError):
            port = DEFAULT_TCP_PORT
        s = socket.create_connection(('127.0.0.1', port), timeout=timeout)
        return s
    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    s.settimeout(timeout)
    s.connect(SOCK_PATH)
    return s


# ────────────────────────────────────────────────────────────────── áudio ────
# O Linux usa as sources/sinks virtuais do PipeWire com cancelamento de eco
# (elfie_mic_aec / elfie_speaker_aec). O Windows não tem equivalente, então lá a
# captura vai direto no dispositivo via dshow e a única defesa contra ela se ouvir
# é o gate por software que o daemon já aplica (_should_mute).

def mic_capture_cmd(sample_rate: int, device: str | None = None) -> list[str]:
    if IS_WINDOWS:
        dev = device or os.environ.get('ELFIE_MIC_DEVICE') or default_input_device() or 'default'
        return ['ffmpeg', '-loglevel', 'error', '-f', 'dshow', '-i', f'audio={dev}',
                '-ar', str(sample_rate), '-ac', '1', '-f', 's16le', 'pipe:1']
    if IS_MACOS:
        dev = device or os.environ.get('ELFIE_MIC_DEVICE') or ':0'
        return ['ffmpeg', '-loglevel', 'error', '-f', 'avfoundation', '-i', dev,
                '-ar', str(sample_rate), '-ac', '1', '-f', 's16le', 'pipe:1']
    return ['ffmpeg', '-loglevel', 'error', '-f', 'pulse', '-i',
            device or 'elfie_mic_aec',
            '-ar', str(sample_rate), '-ac', '1', '-f', 's16le', 'pipe:1']


_cached_input_device: str | None = None


def default_input_device() -> str | None:
    """Primeiro microfone que o dshow enumerar. Só Windows; resultado é cacheado."""
    global _cached_input_device
    if not IS_WINDOWS or _cached_input_device is not None:
        return _cached_input_device
    try:
        out = subprocess.run(
            ['ffmpeg', '-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
            capture_output=True, timeout=10, **popen_flags(),
        ).stderr.decode('utf-8', errors='ignore')
    except Exception:
        return None
    audio_section = False
    for line in out.splitlines():
        if 'DirectShow audio devices' in line:
            audio_section = True
            continue
        if 'DirectShow video devices' in line:
            audio_section = False
            continue
        if audio_section and '"' in line and 'Alternative name' not in line:
            _cached_input_device = line.split('"')[1]
            break
    return _cached_input_device


def playback_env() -> dict:
    """Manda a saída pro sink com AEC no Linux. No resto, ambiente intocado."""
    env = os.environ.copy()
    if IS_LINUX:
        env['PULSE_SINK'] = 'elfie_speaker_aec'
    return env


def playback_cmd(sample_rate: int = 24000) -> list[str]:
    return ['ffplay', '-loglevel', 'warning', '-f', 's16le',
            '-sample_rate', str(sample_rate), '-ch_layout', 'mono',
            '-nodisp', '-autoexit', '-i', 'pipe:0']


def mp3_play_cmd(path: str, volume: float = 1.0, loop: bool = False) -> list[str]:
    """Toca um mp3. mpg123 no Linux (como sempre foi); ffplay no resto, que é a
    única dependência de áudio que já era obrigatória nas outras plataformas."""
    volume = max(0.0, min(1.0, volume))
    if IS_LINUX and which('mpg123'):
        scale = int(32768 * volume)
        cmd = ['mpg123', '-q']
        if loop:
            cmd += ['--loop', '-1']
        return cmd + ['-f', str(scale), str(path)]

    cmd = ['ffplay', '-loglevel', 'quiet', '-nodisp', '-autoexit',
           '-volume', str(int(volume * 100))]
    if loop:
        cmd += ['-loop', '0']
    return cmd + [str(path)]


def interrupt_process(proc) -> None:
    """Pede parada graciosa. SIGINT no POSIX; CTRL_BREAK no Windows, que só chega
    se o processo tiver sido criado com new_process_group()."""
    import signal as _signal
    if IS_WINDOWS:
        try:
            proc.send_signal(_signal.CTRL_BREAK_EVENT)
            return
        except (ValueError, OSError):
            proc.terminate()
            return
    proc.send_signal(_signal.SIGINT)


def new_process_group() -> dict:
    """Flags pra criar um filho interrompível com interrupt_process()."""
    if IS_WINDOWS:
        return {'creationflags': getattr(subprocess, 'CREATE_NEW_PROCESS_GROUP', 0x00000200)}
    return {}


def has_echo_cancellation() -> bool:
    """Se False, o daemon depende só do gate por software pra não se ouvir."""
    return IS_LINUX


# ────────────────────────────────────────────────────────────── clipboard ────

def get_selected_text(max_chars: int = 4000) -> str:
    """Seleção primária no Linux (wl-paste/xsel). No Windows não existe seleção
    primária, então lê o clipboard normal via Win32."""
    if IS_WINDOWS:
        return _windows_clipboard()[:max_chars]

    if IS_MACOS:
        try:
            out = subprocess.run(['pbpaste'], capture_output=True, timeout=0.5).stdout
            return out.decode('utf-8', errors='ignore').strip()[:max_chars]
        except Exception:
            return ''

    for cmd in (['wl-paste', '--primary', '--no-newline'], ['xsel', '--primary']):
        try:
            out = subprocess.run(cmd, capture_output=True, timeout=0.5).stdout
        except Exception:
            continue
        text = out.decode('utf-8', errors='ignore').strip()
        if text:
            return text[:max_chars]
    return ''


def _windows_clipboard() -> str:
    import ctypes
    from ctypes import wintypes
    CF_UNICODETEXT = 13
    u32, k32 = ctypes.windll.user32, ctypes.windll.kernel32
    if not u32.OpenClipboard(None):
        return ''
    try:
        if not u32.IsClipboardFormatAvailable(CF_UNICODETEXT):
            return ''
        handle = u32.GetClipboardData(CF_UNICODETEXT)
        if not handle:
            return ''
        k32.GlobalLock.restype = ctypes.c_void_p
        ptr = k32.GlobalLock(ctypes.c_void_p(handle))
        if not ptr:
            return ''
        try:
            return ctypes.c_wchar_p(ptr).value or ''
        finally:
            k32.GlobalUnlock(ctypes.c_void_p(handle))
    except Exception:
        return ''
    finally:
        u32.CloseClipboard()


# ───────────────────────────────────────────────────────── hotkey global ────

def hotkey_backend() -> str:
    if IS_WINDOWS:
        return 'win32'
    try:
        import evdev  # noqa: F401
        return 'evdev'
    except ImportError:
        return 'none'


def run_windows_hotkeys(bindings: dict, should_stop) -> None:
    """RegisterHotKey + loop de mensagens numa thread própria.

    bindings: {'F9': callable, 'F7': callable}. Usa só ctypes, sem dependência
    nova. Cada hotkey é registrada na thread que roda o loop — exigência do Win32.
    """
    import ctypes
    from ctypes import wintypes

    VK = {'F7': 0x76, 'F8': 0x77, 'F9': 0x78, 'F10': 0x79}
    WM_HOTKEY = 0x0312
    PM_REMOVE = 0x0001

    u32 = ctypes.windll.user32
    ids = {}
    for i, (key, fn) in enumerate(bindings.items(), start=1):
        vk = VK.get(key.upper())
        if vk is None:
            continue
        if u32.RegisterHotKey(None, i, 0, vk):
            ids[i] = (key, fn)
        else:
            print(f'[elfie] não consegui registrar a hotkey {key} '
                  f'(outro programa já usa?)', flush=True)

    if not ids:
        print('[elfie] nenhuma hotkey global registrada', flush=True)
        return

    print(f'[elfie] {" / ".join(k for k, _ in ids.values())} monitorados (Win32)', flush=True)

    msg = wintypes.MSG()
    try:
        while not should_stop():
            # PeekMessage não bloqueia, então o should_stop() é checado de verdade.
            while u32.PeekMessageW(ctypes.byref(msg), None, 0, 0, PM_REMOVE):
                if msg.message == WM_HOTKEY:
                    entry = ids.get(msg.wParam)
                    if entry:
                        try:
                            entry[1]()
                        except Exception as ex:
                            print(f'[elfie] hotkey {entry[0]} falhou: {ex}', flush=True)
            time.sleep(0.03)
    finally:
        for i in ids:
            try:
                u32.UnregisterHotKey(None, i)
            except Exception:
                pass


# ──────────────────────────────────────────────────────────────── overlay ────

def overlay_backend() -> str:
    """Qual implementação de overlay dá pra usar nesta máquina."""
    if IS_WINDOWS:
        try:
            import webview  # noqa: F401
            return 'pywebview'
        except ImportError:
            return 'none'
    if not (os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY')):
        return 'none'
    try:
        import gi  # noqa: F401
        return 'gtk'
    except ImportError:
        return 'none'


def describe_environment() -> str:
    parts = [f'plataforma={PLATFORM_NAME}', f'ipc={ipc_address_label()}',
             f'hotkey={hotkey_backend()}', f'overlay={overlay_backend()}',
             f'aec={"pipewire" if has_echo_cancellation() else "software-gate"}']
    for tool in ('ffmpeg', 'ffplay'):
        parts.append(f'{tool}={"ok" if which(tool) else "AUSENTE"}')
    return '  '.join(parts)


if __name__ == '__main__':
    print(describe_environment())
    print('config :', CONFIG_PATH)
    print('pid    :', PID_PATH)
    print('runtime:', runtime_dir())
