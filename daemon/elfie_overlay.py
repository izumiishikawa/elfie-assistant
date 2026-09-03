#!/usr/bin/env python3
import json
import os
import subprocess
import sys
import threading
import urllib.parse
import warnings
warnings.filterwarnings('ignore')

EMBLEM_SIZE          = 260
EMBLEM_MARGIN_TOP    = 12
EMBLEM_MARGIN_RIGHT  = 12
GREAT_SAGE_HTML = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'overlay', 'great_sage.html')
MIND_GRAPH_HTML = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'overlay', 'mind_graph.html')
SUBTITLE_HTML   = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'overlay', 'subtitle.html')

_DAEMON_DIR = os.path.dirname(os.path.abspath(__file__))
HAND_TRACKER_PYTHON = os.path.join(_DAEMON_DIR, 'hand_tracking_venv', 'bin', 'python')
HAND_TRACKER_SCRIPT = os.path.join(_DAEMON_DIR, 'hand_tracker.py')
HAND_TRACKER_MODEL  = os.path.join(_DAEMON_DIR, 'models', 'hand_landmarker.task')

SUBTITLE_WIDTH        = 280
SUBTITLE_HEIGHT       = 200
SUBTITLE_GAP          = -70
SUBTITLE_MARGIN_TOP   = EMBLEM_MARGIN_TOP + EMBLEM_SIZE + SUBTITLE_GAP
SUBTITLE_MARGIN_RIGHT = EMBLEM_MARGIN_RIGHT + (EMBLEM_SIZE - SUBTITLE_WIDTH) // 2

MIND_FADE_STEP  = 0.06
MIND_OUT_STEP   = 0.05


def _has_display():
    return bool(os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY'))


def _gtk_setup():
    import gi
    gi.require_version('Gtk', '3.0')
    gi.require_version('Gdk', '3.0')
    from gi.repository import Gtk, Gdk, GLib
    import cairo as cairo_module

    try:
        gi.require_version('GtkLayerShell', '0.1')
        from gi.repository import GtkLayerShell
        layer_shell_ok = GtkLayerShell.is_supported()
    except Exception:
        GtkLayerShell = None
        layer_shell_ok = False

    return Gtk, Gdk, GLib, cairo_module, GtkLayerShell, layer_shell_ok


def _webkit_setup():
    import gi
    gi.require_version('WebKit2', '4.1')
    from gi.repository import WebKit2
    return WebKit2


def _make_windows(Gtk, GtkLayerShell, layer_shell_ok, rgba, display, n_mon, w0, h, margin_top, margin_right):
    windows = []
    for i in range(n_mon):
        monitor = display.get_monitor(i)
        geo = monitor.get_geometry()
        wtype = Gtk.WindowType.TOPLEVEL if layer_shell_ok else Gtk.WindowType.POPUP
        w = Gtk.Window(type=wtype)
        w.set_decorated(False)
        w.set_resizable(False)
        w.set_app_paintable(True)
        if rgba:
            w.set_visual(rgba)
        w.set_default_size(w0, h)

        if layer_shell_ok:
            GtkLayerShell.init_for_window(w)
            GtkLayerShell.set_monitor(w, monitor)
            GtkLayerShell.set_layer(w, GtkLayerShell.Layer.OVERLAY)
            GtkLayerShell.set_anchor(w, GtkLayerShell.Edge.TOP, True)
            GtkLayerShell.set_anchor(w, GtkLayerShell.Edge.RIGHT, True)
            GtkLayerShell.set_margin(w, GtkLayerShell.Edge.TOP, margin_top)
            GtkLayerShell.set_margin(w, GtkLayerShell.Edge.RIGHT, margin_right)
            GtkLayerShell.set_exclusive_zone(w, -1)
            GtkLayerShell.set_keyboard_mode(w, GtkLayerShell.KeyboardMode.NONE)
        else:
            w.set_keep_above(True)
            w.move(geo.x + geo.width - w0 - margin_right, geo.y + margin_top)

        windows.append(w)
    return windows


def _make_fullscreen_windows(Gtk, GtkLayerShell, layer_shell_ok, rgba, display, n_mon):
    windows = []
    for i in range(n_mon):
        monitor = display.get_monitor(i)
        geo = monitor.get_geometry()
        wtype = Gtk.WindowType.TOPLEVEL if layer_shell_ok else Gtk.WindowType.POPUP
        w = Gtk.Window(type=wtype)
        w.set_decorated(False)
        w.set_resizable(False)
        w.set_app_paintable(True)
        if rgba:
            w.set_visual(rgba)
        w.set_default_size(geo.width, geo.height)

        if layer_shell_ok:
            GtkLayerShell.init_for_window(w)
            GtkLayerShell.set_monitor(w, monitor)
            GtkLayerShell.set_layer(w, GtkLayerShell.Layer.OVERLAY)
            for edge in (GtkLayerShell.Edge.TOP, GtkLayerShell.Edge.RIGHT,
                         GtkLayerShell.Edge.BOTTOM, GtkLayerShell.Edge.LEFT):
                GtkLayerShell.set_anchor(w, edge, True)
            GtkLayerShell.set_exclusive_zone(w, -1)
            GtkLayerShell.set_keyboard_mode(w, GtkLayerShell.KeyboardMode.NONE)
        else:
            w.set_keep_above(True)
            w.move(geo.x, geo.y)

        windows.append(w)
    return windows


def run_active_indicator():
    Gtk, Gdk, GLib, cairo_module, GtkLayerShell, layer_shell_ok = _gtk_setup()
    WebKit2 = _webkit_setup()

    eof_flag = [False]

    screen  = Gdk.Screen.get_default()
    rgba    = screen.get_rgba_visual()
    display = Gdk.Display.get_default()
    n_mon   = display.get_n_monitors()

    emblem_windows = _make_windows(
        Gtk, GtkLayerShell, layer_shell_ok, rgba, display, n_mon,
        EMBLEM_SIZE, EMBLEM_SIZE, EMBLEM_MARGIN_TOP, EMBLEM_MARGIN_RIGHT,
    )
    subtitle_windows = _make_windows(
        Gtk, GtkLayerShell, layer_shell_ok, rgba, display, n_mon,
        SUBTITLE_WIDTH, SUBTITLE_HEIGHT, SUBTITLE_MARGIN_TOP, SUBTITLE_MARGIN_RIGHT,
    )
    windows = emblem_windows + subtitle_windows

    ucm = WebKit2.UserContentManager()
    ucm.register_script_message_handler('elfieLog')

    def _on_console_msg(_manager, js_value, *_args):
        try:
            text = js_value.to_string()
        except Exception:
            try:
                text = js_value.get_js_value().to_string()
            except Exception as ex:
                text = f'<unreadable console message: {ex}>'
        print(f'\n[subtitle] JS console: {text}', flush=True)

    ucm.connect('script-message-received::elfieLog', _on_console_msg)

    webview_ready = {}

    webviews = []
    for w, uri in (
        [(w, f'file://{GREAT_SAGE_HTML}') for w in emblem_windows]
        + [(w, f'file://{SUBTITLE_HTML}') for w in subtitle_windows]
    ):
        wv = WebKit2.WebView(user_content_manager=ucm)
        wv.set_background_color(Gdk.RGBA(0, 0, 0, 0))
        settings = wv.get_settings()
        settings.set_enable_developer_extras(False)
        settings.set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.ALWAYS)

        webview_ready[id(wv)] = False

        def _on_load_changed(webview, load_event, _uri=uri):
            if load_event == WebKit2.LoadEvent.FINISHED:
                webview_ready[id(webview)] = True
                print(f'\n[subtitle] webview finished loading: {_uri}', flush=True)

        wv.connect('load-changed', _on_load_changed)
        wv.load_uri(uri)
        w.add(wv)
        webviews.append(wv)

    def _on_js_result(webview, result, _user_data):
        try:
            webview.run_javascript_finish(result)
        except Exception as ex:
            print(f'\n[elfie-overlay] JS error: {ex}', flush=True)

    def _run_js(script):
        for wv in webviews:
            if not webview_ready.get(id(wv)):
                print(f'\n[subtitle] _run_js SKIPPED — webview not finished loading yet: '
                      f'{script[:100]!r}', flush=True)
                continue
            try:
                wv.run_javascript(script, None, _on_js_result, None)
            except Exception:
                pass
        return False

    def _push_energy(e):
        return _run_js(f'window.setEnergy && window.setEnergy({e:.4f})')

    def _push_state(state):
        return _run_js(f'window.setState && window.setState({json.dumps(state)})')

    def _push_subtitle(text):
        return _run_js(f'window.setSubtitle && window.setSubtitle({json.dumps(text)})')

    def _push_kanji(ch):
        return _run_js(f'window.showKanji && window.showKanji({json.dumps(ch)})')

    STEP     = 0.12
    OUT_STEP = 0.035
    alpha = [0.0]
    phase = ['in']

    def tick():
        if phase[0] == 'in':
            alpha[0] = min(1.0, alpha[0] + STEP)
            for w in windows:
                w.set_opacity(alpha[0])
            if alpha[0] >= 1.0:
                phase[0] = 'hold'
            return True
        elif phase[0] == 'hold':
            if eof_flag[0]:
                phase[0] = 'out'
            return True
        elif phase[0] == 'out':
            alpha[0] = max(0.0, alpha[0] - OUT_STEP)
            for w in windows:
                w.set_opacity(alpha[0])
            if alpha[0] <= 0.0:
                Gtk.main_quit()
                return False
        return True

    for w in windows:
        w.set_opacity(0.0)
        w.show_all()
        w.input_shape_combine_region(cairo_module.Region())
    GLib.timeout_add(16, tick)

    def _reader():
        try:
            for line in sys.stdin.buffer:
                line = line.strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except Exception:
                    continue
                if 'energy' in msg:
                    try:
                        e = float(msg['energy'])
                    except (TypeError, ValueError):
                        continue
                    GLib.idle_add(_push_energy, e)
                if 'state' in msg:
                    GLib.idle_add(_push_state, msg['state'])
                if 'subtitle' in msg:
                    GLib.idle_add(_push_subtitle, msg['subtitle'] or '')
                if 'kanji' in msg:
                    GLib.idle_add(_push_kanji, msg['kanji'] or '')
        except Exception:
            pass
        eof_flag[0] = True

    threading.Thread(target=_reader, daemon=True).start()

    Gtk.main()


def run_mind_overlay(api_base):
    Gtk, Gdk, GLib, cairo_module, GtkLayerShell, layer_shell_ok = _gtk_setup()
    WebKit2 = _webkit_setup()

    html_uri = f'file://{MIND_GRAPH_HTML}?api=' + urllib.parse.quote(api_base, safe='')

    screen  = Gdk.Screen.get_default()
    rgba    = screen.get_rgba_visual()
    display = Gdk.Display.get_default()
    n_mon   = display.get_n_monitors()

    windows = _make_fullscreen_windows(Gtk, GtkLayerShell, layer_shell_ok, rgba, display, n_mon)

    webviews = []
    for w in windows:
        wv = WebKit2.WebView()
        wv.set_background_color(Gdk.RGBA(0, 0, 0, 0))
        settings = wv.get_settings()
        settings.set_enable_developer_extras(False)
        settings.set_hardware_acceleration_policy(WebKit2.HardwareAccelerationPolicy.ALWAYS)
        wv.load_uri(html_uri)
        w.add(wv)
        webviews.append(wv)

    alpha      = [0.0]
    phase      = ['in']
    close_flag = [False]

    def tick():
        if phase[0] == 'in':
            alpha[0] = min(1.0, alpha[0] + MIND_FADE_STEP)
            for w in windows:
                w.set_opacity(alpha[0])
            if alpha[0] >= 1.0:
                phase[0] = 'hold'
            return True
        elif phase[0] == 'hold':
            if close_flag[0]:
                phase[0] = 'out'
            return True
        elif phase[0] == 'out':
            alpha[0] = max(0.0, alpha[0] - MIND_OUT_STEP)
            for w in windows:
                w.set_opacity(alpha[0])
            if alpha[0] <= 0.0:
                Gtk.main_quit()
                return False
        return True

    for w in windows:
        w.set_opacity(0.0)
        w.show_all()
        w.input_shape_combine_region(cairo_module.Region())
    GLib.timeout_add(16, tick)

    def _reader():
        try:
            for _line in sys.stdin.buffer:
                GLib.idle_add(close_flag.__setitem__, 0, True)
                break
        except Exception:
            pass
        GLib.idle_add(close_flag.__setitem__, 0, True)

    threading.Thread(target=_reader, daemon=True).start()

    hand_proc = None
    if os.path.exists(HAND_TRACKER_PYTHON) and os.path.exists(HAND_TRACKER_SCRIPT) and os.path.exists(HAND_TRACKER_MODEL):
        try:
            hand_proc = subprocess.Popen(
                [HAND_TRACKER_PYTHON, HAND_TRACKER_SCRIPT, HAND_TRACKER_MODEL],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                stdin=subprocess.DEVNULL,
                text=True,
                bufsize=1,
            )
        except Exception:
            hand_proc = None

    if hand_proc is not None:
        def _on_hand_js_result(webview, result, _user_data):
            try:
                webview.run_javascript_finish(result)
            except Exception:
                pass

        def _push_hand_update(payload_json):
            script = f'window.mindGraphHandUpdate && window.mindGraphHandUpdate({payload_json})'
            for wv in webviews:
                try:
                    wv.run_javascript(script, None, _on_hand_js_result, None)
                except Exception:
                    pass
            return False

        def _hand_reader():
            try:
                for line in hand_proc.stdout:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        json.loads(line)
                    except Exception:
                        continue
                    GLib.idle_add(_push_hand_update, line)
            except Exception:
                pass

        threading.Thread(target=_hand_reader, daemon=True).start()

    try:
        Gtk.main()
    finally:
        if hand_proc is not None:
            try:
                hand_proc.terminate()
            except Exception:
                pass


def main():
    if len(sys.argv) < 2:
        sys.exit(1)

    kind = sys.argv[1]
    if not _has_display():
        sys.exit(0)

    try:
        if kind == 'active':
            run_active_indicator()
        elif kind == 'mind':
            api_base = sys.argv[2] if len(sys.argv) > 2 else 'http://localhost:3000'
            run_mind_overlay(api_base)
        else:
            sys.exit(1)
    except Exception:
        pass


if __name__ == '__main__':
    main()
