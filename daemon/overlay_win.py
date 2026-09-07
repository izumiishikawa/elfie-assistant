#!/usr/bin/env python3
"""Backend de overlay do Windows.

Reimplementa os três overlays do elfie_overlay.py (active / mind / skill_evolution)
em cima do WebView2 via pywebview, carregando EXATAMENTE os mesmos arquivos HTML e
falando EXATAMENTE o mesmo protocolo de stdin — o daemon não sabe qual backend está
rodando.

O que o GTK faz no Linux e como é feito aqui:
  - camada de overlay (GtkLayerShell)  -> WS_EX_TOPMOST + on_top do pywebview
  - clique atravessa (input_shape)     -> WS_EX_TRANSPARENT
  - fundo transparente                 -> WS_EX_LAYERED + transparent=True
  - fade de opacidade (set_opacity)    -> SetLayeredWindowAttributes

Diferença conhecida: o GTK abre uma janela por monitor; aqui é só o monitor
primário. Multi-monitor no pywebview exigiria uma janela por display com
posicionamento manual, e sem uma máquina Windows pra medir isso viraria chute.
"""

from __future__ import annotations

import ctypes
import json
import sys
import threading
import time
import urllib.parse
from ctypes import wintypes

try:
    import webview
    PYWEBVIEW_OK = True
except ImportError:
    PYWEBVIEW_OK = False

GWL_EXSTYLE = -20
WS_EX_LAYERED = 0x00080000
WS_EX_TRANSPARENT = 0x00000020
WS_EX_TOOLWINDOW = 0x00000080  # tira da Alt+Tab e da barra de tarefas
WS_EX_NOACTIVATE = 0x08000000  # nunca rouba foco
LWA_ALPHA = 0x00000002


def _user32():
    return ctypes.windll.user32


def _find_hwnd(title: str):
    """pywebview não expõe o HWND; acha pelo título exato da janela."""
    return _user32().FindWindowW(None, title)


def _make_overlay_window(hwnd) -> None:
    """Topmost, click-through, sem foco, fora da Alt+Tab."""
    if not hwnd:
        return
    u = _user32()
    u.SetWindowLongPtrW.restype = ctypes.c_void_p
    u.SetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_void_p]
    u.GetWindowLongPtrW.restype = ctypes.c_void_p
    u.GetWindowLongPtrW.argtypes = [wintypes.HWND, ctypes.c_int]

    style = u.GetWindowLongPtrW(hwnd, GWL_EXSTYLE) or 0
    style |= WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE
    u.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, style)


def _set_opacity(hwnd, alpha: float) -> None:
    if not hwnd:
        return
    value = max(0, min(255, int(alpha * 255)))
    _user32().SetLayeredWindowAttributes(hwnd, 0, value, LWA_ALPHA)


def _screen_size() -> tuple[int, int]:
    u = _user32()
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # per-monitor DPI
    except Exception:
        try:
            u.SetProcessDPIAware()
        except Exception:
            pass
    return u.GetSystemMetrics(0), u.GetSystemMetrics(1)


class _Overlay:
    """Uma janela pywebview + o ctypes que a transforma em overlay de verdade."""

    def __init__(self, title, url, width, height, x, y):
        self.title = title
        self.hwnd = None
        self.alpha = 0.0
        self.window = webview.create_window(
            title, url,
            width=width, height=height, x=x, y=y,
            frameless=True, easy_drag=False, on_top=True,
            transparent=True, background_color='#000000',
            resizable=False, minimized=False,
        )

    def attach(self, timeout=8.0):
        """Espera a janela existir de fato pra poder mexer no estilo dela."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            hwnd = _find_hwnd(self.title)
            if hwnd:
                self.hwnd = hwnd
                _make_overlay_window(hwnd)
                _set_opacity(hwnd, 0.0)
                return True
            time.sleep(0.05)
        print(f'[overlay-win] não achei a janela "{self.title}"', flush=True)
        return False

    def set_opacity(self, alpha):
        self.alpha = alpha
        _set_opacity(self.hwnd, alpha)

    def js(self, script):
        try:
            self.window.evaluate_js(script)
        except Exception:
            pass

    def destroy(self):
        try:
            self.window.destroy()
        except Exception:
            pass


def _fade(overlays, target, step, done=None):
    """Fade cooperativo — mesma ideia do tick() do GTK, em thread própria."""
    while True:
        current = overlays[0].alpha if overlays else target
        if abs(current - target) < 1e-3:
            break
        nxt = min(target, current + step) if target > current else max(target, current - step)
        for o in overlays:
            o.set_opacity(nxt)
        time.sleep(0.016)
    for o in overlays:
        o.set_opacity(target)
    if done:
        done()


def _stdin_lines(on_message, on_eof):
    def _reader():
        try:
            for line in sys.stdin.buffer:
                line = line.strip()
                if not line:
                    continue
                try:
                    on_message(json.loads(line))
                except Exception:
                    continue
        except Exception:
            pass
        on_eof()
    threading.Thread(target=_reader, daemon=True).start()


# ─────────────────────────────────────────────────────────── modo: active ────

def run_active_indicator(great_sage_html, subtitle_html,
                         emblem_size, emblem_margin_top, emblem_margin_right,
                         subtitle_w, subtitle_h, subtitle_margin_top, subtitle_margin_right):
    sw, _sh = _screen_size()

    emblem = _Overlay('elfie-emblem', f'file:///{great_sage_html}',
                      emblem_size, emblem_size,
                      sw - emblem_size - emblem_margin_right, emblem_margin_top)
    subtitle = _Overlay('elfie-subtitle', f'file:///{subtitle_html}',
                        subtitle_w, subtitle_h,
                        sw - subtitle_w - subtitle_margin_right, subtitle_margin_top)
    overlays = [emblem, subtitle]

    def _boot():
        for o in overlays:
            o.attach()
        _fade(overlays, 1.0, 0.12)

        def _on_msg(msg):
            if 'energy' in msg:
                try:
                    emblem.js(f'window.setEnergy && window.setEnergy({float(msg["energy"]):.4f})')
                except (TypeError, ValueError):
                    pass
            if 'state' in msg:
                for o in overlays:
                    o.js(f'window.setState && window.setState({json.dumps(msg["state"])})')
            if 'subtitle' in msg:
                subtitle.js(f'window.setSubtitle && window.setSubtitle({json.dumps(msg["subtitle"] or "")})')
            if 'kanji' in msg:
                emblem.js(f'window.showKanji && window.showKanji({json.dumps(msg["kanji"] or "")})')

        def _on_eof():
            _fade(overlays, 0.0, 0.035, done=lambda: [o.destroy() for o in overlays])

        _stdin_lines(_on_msg, _on_eof)

    webview.start(_boot, gui='edgechromium', private_mode=False)


# ───────────────────────────────────────────────────────────── modo: mind ────

def run_mind_overlay(mind_graph_html, api_base, fade_step, out_step):
    sw, sh = _screen_size()
    uri = f'file:///{mind_graph_html}?api=' + urllib.parse.quote(api_base, safe='')
    win = _Overlay('elfie-mind', uri, sw, sh, 0, 0)

    def _boot():
        win.attach()
        _fade([win], 1.0, fade_step)
        _stdin_lines(lambda _m: None,
                     lambda: _fade([win], 0.0, out_step, done=win.destroy))

    webview.start(_boot, gui='edgechromium', private_mode=False)


# ────────────────────────────────────────────────── modo: skill_evolution ────

def run_skill_evolution_overlay(skill_html, line, skill_name, stage, fade_step, out_step):
    sw, sh = _screen_size()
    data = urllib.parse.quote(json.dumps(
        {'line': line, 'skillName': skill_name, 'stage': stage}), safe='')
    win = _Overlay('elfie-skill-evolution', f'file:///{skill_html}?data={data}', sw, sh, 0, 0)

    def _boot():
        win.attach()
        _fade([win], 1.0, fade_step)

        def _on_msg(msg):
            action = msg.get('action') or msg.get('cmd')
            if action == 'resolve':
                win.js('window.resolve && window.resolve()')
            elif action == 'close':
                _fade([win], 0.0, out_step, done=win.destroy)

        _stdin_lines(_on_msg, lambda: _fade([win], 0.0, out_step, done=win.destroy))

    webview.start(_boot, gui='edgechromium', private_mode=False)


def available() -> bool:
    return PYWEBVIEW_OK
