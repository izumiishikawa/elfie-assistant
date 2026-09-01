#!/usr/bin/env bash

DAEMON_PY="/home/izumi/Documentos/elfie/daemon/elfie_daemon.py"
API_DIR="/home/izumi/Documentos/elfie/api"
OPENVT_PATH="/home/izumi/Documentos/elfie/waifu-persona"
ELFIE_WEB_DIR="/home/izumi/Documentos/elfie/elfie-web"
WIN_TITLE="waifu-persona (DEBUG)"

echo "[start] iniciando API..."
(cd "$API_DIR" && ORT_LOGGING_LEVEL=3 npm start) &
API_PID=$!

echo -n "[start] aguardando API ficar pronta..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:3000/api/characters >/dev/null 2>&1; then
    echo " pronta!"
    break
  fi
  if [[ $i -eq 30 ]]; then
    echo " timeout, subindo daemon mesmo assim"
  fi
  sleep 1
  echo -n "."
done

echo "[start] iniciando elfie-web..."
(cd "$ELFIE_WEB_DIR" && npm run dev) &
ELFIE_WEB_PID=$!

echo "[start] iniciando daemon..."
python3 "$DAEMON_PY" &
DAEMON_PID=$!

echo "[start] configurando regra KWin sem borda para waifu-persona..."
python3 - <<'PYEOF'
import configparser, os, sys

path = os.path.expanduser("~/.config/kwinrulesrc")
cfg = configparser.RawConfigParser()
cfg.optionxform = str  # preserve case
cfg.read(path)

# Check if rule already exists
count = int(cfg.get("General", "count", fallback="0"))
rules_str = cfg.get("General", "rules", fallback="")
existing_rules = [r.strip() for r in rules_str.split(",") if r.strip()]

target_sec = None
for sec in existing_rules:
    if cfg.has_section(sec) and "waifu-persona" in cfg.get(sec, "Description", fallback="").lower():
        target_sec = sec
        break

if target_sec is None:
    count += 1
    target_sec = str(count)
    existing_rules.append(target_sec)
    if not cfg.has_section("General"):
        cfg.add_section("General")
    cfg.set("General", "count", str(count))
    cfg.set("General", "rules", ",".join(existing_rules))

if not cfg.has_section(target_sec):
    cfg.add_section(target_sec)

cfg.set(target_sec, "Description", "waifu-persona no border")
cfg.set(target_sec, "noborder", "true")
cfg.set(target_sec, "noborderrule", "2")
cfg.set(target_sec, "title", "waifu-persona")
cfg.set(target_sec, "titlematch", "2")

with open(path, "w") as f:
    cfg.write(f, space_around_delimiters=" = ")

print(f"[kwin] regra borderless salva na seção [{target_sec}]")
PYEOF

# Carrega a regra ANTES de lançar o Godot para que a janela já nasça sem borda
qdbus6 org.kde.KWin /KWin reconfigure 2>/dev/null

echo "[start] iniciando waifu-persona..."
godot-4 --display-driver x11 --path "$OPENVT_PATH" &
OPENVT_PID=$!

echo "[start] aguardando janela do waifu-persona..."
for i in $(seq 1 60); do
  WIN_ID=$(wmctrl -l 2>/dev/null | grep "$WIN_TITLE" | awk '{print $1}')
  if [[ -n "$WIN_ID" ]]; then
    # Aplica imediatamente — sem qdbus6 reconfigure aqui (causaria KWin re-decorar)
    xprop -id "$WIN_ID" -f _MOTIF_WM_HINTS 32c -set _MOTIF_WM_HINTS "2, 0, 0, 0, 0" 2>/dev/null
    sleep 0.3
    xprop -id "$WIN_ID" -f _MOTIF_WM_HINTS 32c -set _MOTIF_WM_HINTS "2, 0, 0, 0, 0" 2>/dev/null
    wmctrl -i -r "$WIN_ID" -e 0,3300,260,540,820 2>/dev/null
    sleep 0.3
    xprop -id "$WIN_ID" -f _MOTIF_WM_HINTS 32c -set _MOTIF_WM_HINTS "2, 0, 0, 0, 0" 2>/dev/null
    echo "[start] janela posicionada sem borda: 540x820 em +3300+260"
    break
  fi
  if [[ $i -eq 60 ]]; then
    echo "[start] timeout: janela do waifu-persona não apareceu"
  fi
  sleep 0.5
done

echo "[start] rodando — Ctrl+C para encerrar tudo"
trap "kill $API_PID $ELFIE_WEB_PID $DAEMON_PID $OPENVT_PID 2>/dev/null; echo; echo '[start] encerrado'" INT TERM
wait $API_PID $ELFIE_WEB_PID $DAEMON_PID $OPENVT_PID
