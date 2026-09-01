#!/usr/bin/env bash
set -e

DAEMON_DIR="$(cd "$(dirname "$0")" && pwd)"
VENV_DIR="$DAEMON_DIR/hand_tracking_venv"
MODEL_DIR="$DAEMON_DIR/models"
MODEL_PATH="$MODEL_DIR/hand_landmarker.task"
MODEL_URL="https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task"

if [ ! -d "$VENV_DIR" ]; then
  echo "[hand-tracking] creating venv at $VENV_DIR..."
  python3 -m venv "$VENV_DIR"
fi

echo "[hand-tracking] installing opencv + mediapipe (this pulls a fair amount, be patient)..."
"$VENV_DIR/bin/pip" install --quiet --upgrade pip
"$VENV_DIR/bin/pip" install --quiet opencv-contrib-python mediapipe

mkdir -p "$MODEL_DIR"
if [ ! -f "$MODEL_PATH" ]; then
  echo "[hand-tracking] downloading hand landmark model (~8MB)..."
  curl -fsSL -o "$MODEL_PATH" "$MODEL_URL"
fi

echo ""
echo "✓ Hand tracking ready — 'mostra sua mente' will now respond to hand position in"
echo "  front of the webcam automatically. No daemon restart needed if it's already"
echo "  running the way you'd want it live, but a fresh 'elfie-daemon' pick-up is safest."
