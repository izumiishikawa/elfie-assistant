#!/usr/bin/env python3
"""Bandeja do Elfie no Windows — o painel de controle das tres partes.

Existe porque no Windows o Elfie sao TRES processos (servidor Node, app web e
daemon do overlay) e nao ha equivalente do `elfie-daemon &` do Linux. Registrar
tudo como servico do Windows esconderia demais: quando algo nao sobe, o usuario
precisa ver QUAL parte caiu e ler o log dela sem abrir um terminal. Um icone com
cor de estado e um menu com "ver log" por parte resolve isso sem nenhum console.

Roda no Python privado da instalacao (runtime\\python\\pythonw.exe) — extensao
.pyw pra abrir sem janela de console.
"""

import ctypes
import os
import subprocess
import threading
import time
import urllib.error
import urllib.request
import webbrowser
import winreg
from pathlib import Path

import pystray
from PIL import Image, ImageDraw

# ─────────────────────────────────────────────────────────────── caminhos ────
# O .pyw mora em <instalacao>\tools, entao a raiz e um nivel acima. Nada aqui
# depende do diretorio de trabalho: o atalho do menu iniciar, o do Startup e um
# duplo-clique manual tem cwd diferentes.
BASE = Path(__file__).resolve().parent.parent
NODE = BASE / 'runtime' / 'node' / 'node.exe'
PYTHONW = BASE / 'runtime' / 'python' / 'pythonw.exe'
FFMPEG_BIN = BASE / 'runtime' / 'ffmpeg' / 'bin'
LOGS = BASE / 'logs'
ENV_FILE = BASE / 'api' / '.env'
ICON_FILE = BASE / 'assets' / 'elfie.ico'

WEB_URL = 'http://127.0.0.1:5173'
API_HEALTH = 'http://127.0.0.1:3000/api/characters'

RUN_KEY = r'Software\Microsoft\Windows\CurrentVersion\Run'
RUN_VALUE = 'Elfie'

LOG_MAX_BYTES = 5 * 1024 * 1024
CREATE_NO_WINDOW = 0x08000000

# ─────────────────────────────────────────────────────────────── idiomas ────
# Duas linguas so, escolhidas pelo idioma do Windows — o instalador ja oferece as
# mesmas duas, seria estranho o icone falar outra coisa. 0x416 = pt-BR, 0x816 = pt-PT.
STRINGS = {
    'pt': {
        'open': 'Abrir o Elfie', 'server': 'Servidor', 'web': 'Aplicativo web',
        'daemon': 'Overlay do desktop', 'start': 'Iniciar', 'stop': 'Parar',
        'restart': 'Reiniciar', 'log': 'Ver o log', 'restart_all': 'Reiniciar tudo',
        'edit_config': 'Editar configuração (.env)', 'open_logs': 'Abrir a pasta de logs',
        'autostart': 'Iniciar com o Windows', 'quit': 'Sair do Elfie',
        'running': 'no ar', 'stopped': 'parado', 'starting': 'subindo',
        'title_ok': 'Elfie — tudo no ar', 'title_partial': 'Elfie — parcialmente no ar',
        'title_off': 'Elfie — parado',
    },
    'en': {
        'open': 'Open Elfie', 'server': 'Server', 'web': 'Web app',
        'daemon': 'Desktop overlay', 'start': 'Start', 'stop': 'Stop',
        'restart': 'Restart', 'log': 'View log', 'restart_all': 'Restart everything',
        'edit_config': 'Edit configuration (.env)', 'open_logs': 'Open logs folder',
        'autostart': 'Start with Windows', 'quit': 'Quit Elfie',
        'running': 'running', 'stopped': 'stopped', 'starting': 'starting',
        'title_ok': 'Elfie — all running', 'title_partial': 'Elfie — partially running',
        'title_off': 'Elfie — stopped',
    },
}


def _pick_language() -> dict:
    try:
        lang = ctypes.windll.kernel32.GetUserDefaultUILanguage() & 0x3FF
    except Exception:
        return STRINGS['en']
    return STRINGS['pt'] if lang == 0x16 else STRINGS['en']


T = _pick_language()


# ─────────────────────────────────────────────────────────────── processos ────
def child_env() -> dict:
    """PATH com os runtimes PRIVADOS na frente.

    O instalador de proposito nao mexe no PATH do sistema (pra nao brigar com um
    Node/Python que o usuario ja tenha), entao o daemon so acha ffmpeg.exe/
    ffplay.exe — que ele resolve por shutil.which — se a bandeja injetar aqui.
    """
    env = os.environ.copy()
    extra = [str(NODE.parent), str(PYTHONW.parent)]
    if FFMPEG_BIN.is_dir():
        extra.append(str(FFMPEG_BIN))
    env['PATH'] = os.pathsep.join(extra + [env.get('PATH', '')])
    return env


class Service:
    """Uma das tres partes do Elfie: como subir, onde logar, como saber se vive."""

    def __init__(self, key, label, cmd, cwd, installed, health=None):
        self.key = key
        self.label = label
        self.cmd = cmd
        self.cwd = cwd
        self.installed = installed
        self.health = health
        self.proc = None
        self._lock = threading.Lock()
        self._health_cache = False

    @property
    def log_path(self) -> Path:
        return LOGS / f'{self.key}.log'

    def running(self) -> bool:
        return self.proc is not None and self.proc.poll() is None

    def probe(self):
        """Sonda de verdade (com rede) — so a thread do watcher chama.

        Vivo E respondendo: um servidor que subiu mas morreu no connectDB fica com
        o processo vivo por um instante, e amarelo em vez de verde deixa isso
        visivel em vez de mentir que esta tudo bem.
        """
        if not self.running():
            self._health_cache = False
            return
        if self.health is None:
            self._health_cache = True
            return
        try:
            with urllib.request.urlopen(self.health, timeout=1.5):
                self._health_cache = True
        except urllib.error.HTTPError:
            self._health_cache = True   # respondeu (403/404 e resposta): esta de pe
        except Exception:
            self._health_cache = False

    def healthy(self) -> bool:
        """Ultimo resultado conhecido, sem tocar na rede. O menu chama isso a cada
        redesenho: com a sonda de 1,5s aqui dentro, abrir a bandeja com tudo fora
        do ar travava por varios segundos antes de aparecer."""
        return self._health_cache and self.running()

    def start(self):
        with self._lock:
            if self.running() or not self.installed:
                return
            LOGS.mkdir(parents=True, exist_ok=True)
            # Trunca em vez de rotacionar: log de servico local so serve pro
            # ultimo problema, e um esquema de rotacao seria mais codigo do que a
            # bandeja inteira merece.
            if self.log_path.exists() and self.log_path.stat().st_size > LOG_MAX_BYTES:
                self.log_path.unlink()
            log = open(self.log_path, 'ab', buffering=0)
            log.write(f"\n===== {time.strftime('%Y-%m-%d %H:%M:%S')} =====\n".encode())
            self.proc = subprocess.Popen(
                self.cmd, cwd=str(self.cwd), env=child_env(),
                stdout=log, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                creationflags=CREATE_NO_WINDOW,
            )

    def stop(self):
        with self._lock:
            p = self.proc
            self.proc = None
        if p is None or p.poll() is not None:
            return
        try:
            p.terminate()
            p.wait(timeout=8)
        except Exception:
            try:
                p.kill()
            except Exception:
                pass

    def restart(self):
        self.stop()
        time.sleep(0.6)
        self.start()


SERVICES = [
    Service('api', T['server'], [str(NODE), 'server.js'], BASE / 'api',
            (BASE / 'api' / 'server.js').exists(), health=API_HEALTH),
    Service('web', T['web'], [str(NODE), str(BASE / 'tools' / 'serve_web.mjs')], BASE,
            (BASE / 'elfie-web').is_dir(), health=WEB_URL),
    Service('daemon', T['daemon'], [str(PYTHONW), 'elfie_daemon.py'], BASE / 'daemon',
            (BASE / 'daemon' / 'elfie_daemon.py').exists()),
]
BY_KEY = {s.key: s for s in SERVICES}


# ──────────────────────────────────────────────────────────── inicio automatico ────
def autostart_enabled() -> bool:
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
            winreg.QueryValueEx(k, RUN_VALUE)
        return True
    except OSError:
        return False


def toggle_autostart():
    if autostart_enabled():
        try:
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, RUN_KEY, 0, winreg.KEY_SET_VALUE) as k:
                winreg.DeleteValue(k, RUN_VALUE)
        except OSError:
            pass
    else:
        cmd = f'"{PYTHONW}" "{Path(__file__).resolve()}"'
        with winreg.CreateKey(winreg.HKEY_CURRENT_USER, RUN_KEY) as k:
            winreg.SetValueEx(k, RUN_VALUE, 0, winreg.REG_SZ, cmd)


# ────────────────────────────────────────────────────────────────── icone ────
GREEN, YELLOW, RED = (76, 209, 118), (232, 176, 61), (214, 79, 79)


def status_color():
    active = [s for s in SERVICES if s.installed]
    if not active:
        return RED
    ok = sum(1 for s in active if s.healthy())
    if ok == len(active):
        return GREEN
    # Processo de pe mas ainda sem responder = subindo, nao morto: o servidor leva
    # uns 10s pra conectar no Mongo e carregar os modelos, e pintar de vermelho
    # nesse intervalo faria TODA inicializacao normal parecer uma falha.
    if any(s.running() for s in active):
        return YELLOW
    return RED


def make_icon(color):
    """Icone do app com um ponto de estado no canto. O ponto e o ponto: num
    tamanho de bandeja (16px reais) a cor e a unica coisa legivel de relance."""
    size = 64
    try:
        img = Image.open(ICON_FILE).convert('RGBA').resize((size, size), Image.LANCZOS)
    except Exception:
        img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        ImageDraw.Draw(img).ellipse((6, 6, size - 6, size - 6), fill=(120, 120, 130, 255))
    d = ImageDraw.Draw(img)
    r = 22
    box = (size - r - 2, size - r - 2, size - 2, size - 2)
    d.ellipse(box, fill=color + (255,), outline=(20, 20, 24, 255), width=3)
    return img


# ───────────────────────────────────────────────────────────────── acoes ────
def open_web(*_):
    webbrowser.open(WEB_URL)


def open_path(path: Path):
    try:
        os.startfile(str(path))          # noqa: S606 — shell do Windows, e o ponto
    except Exception:
        pass


def edit_env(*_):
    if not ENV_FILE.exists():
        ENV_FILE.parent.mkdir(parents=True, exist_ok=True)
        ENV_FILE.write_text('# OPENROUTER_API_KEY=sk-or-v1-...\n', encoding='utf-8')
    # notepad explicito: .env nao tem associacao de tipo no Windows, entao
    # os.startfile abriria o dialogo de "escolha um aplicativo".
    subprocess.Popen(['notepad.exe', str(ENV_FILE)], creationflags=CREATE_NO_WINDOW)


def service_menu(svc: Service):
    def state_text(_=None):
        return f'{svc.label} — {T["running"] if svc.healthy() else (T["starting"] if svc.running() else T["stopped"])}'

    return pystray.MenuItem(state_text, pystray.Menu(
        pystray.MenuItem(T['start'], lambda *_: svc.start(), enabled=lambda _: not svc.running()),
        pystray.MenuItem(T['stop'], lambda *_: svc.stop(), enabled=lambda _: svc.running()),
        pystray.MenuItem(T['restart'], lambda *_: threading.Thread(target=svc.restart, daemon=True).start()),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(T['log'], lambda *_: open_path(svc.log_path)),
    ), enabled=lambda _: svc.installed)


def restart_all(*_):
    def run():
        for s in SERVICES:
            if s.installed:
                s.restart()
    threading.Thread(target=run, daemon=True).start()


def quit_all(icon, *_):
    for s in SERVICES:
        s.stop()
    icon.stop()


def build_menu():
    items = [pystray.MenuItem(T['open'], open_web, default=True), pystray.Menu.SEPARATOR]
    items += [service_menu(s) for s in SERVICES]
    items += [
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(T['restart_all'], restart_all),
        pystray.MenuItem(T['edit_config'], edit_env),
        pystray.MenuItem(T['open_logs'], lambda *_: open_path(LOGS)),
        pystray.MenuItem(T['autostart'], lambda *_: toggle_autostart(),
                         checked=lambda _: autostart_enabled()),
        pystray.Menu.SEPARATOR,
        pystray.MenuItem(T['quit'], quit_all),
    ]
    return pystray.Menu(*items)


def watcher(icon):
    """Reflete o estado real no icone. Nao ressuscita nada de proposito: se o
    servidor esta em loop de crash por falta de MONGODB_URI, reinicio automatico
    so esconderia a causa — o icone fica amarelo/vermelho e o log conta o resto."""
    last = None
    while True:
        for s in SERVICES:
            if s.installed:
                s.probe()
        color = status_color()
        if color != last:
            last = color
            icon.icon = make_icon(color)
            icon.title = {GREEN: T['title_ok'], YELLOW: T['title_partial'],
                          RED: T['title_off']}[color]
        icon.update_menu()
        time.sleep(4)


def main():
    LOGS.mkdir(parents=True, exist_ok=True)
    for s in SERVICES:
        s.start()

    icon = pystray.Icon('elfie', make_icon(YELLOW), T['title_partial'], build_menu())
    threading.Thread(target=watcher, args=(icon,), daemon=True).start()
    try:
        icon.run()
    finally:
        for s in SERVICES:
            s.stop()


if __name__ == '__main__':
    main()
