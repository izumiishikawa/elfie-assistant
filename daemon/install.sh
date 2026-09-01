#!/usr/bin/env bash
set -e

DAEMON_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "[elfie] instalando dependências Python..."
pip3 install -r "$DAEMON_DIR/requirements.txt" --break-system-packages --quiet

echo "[elfie] adicionando usuário ao grupo 'input' (para evdev/F9)..."
sudo usermod -aG input "$USER"

echo "[elfie] instalando comandos em ~/.local/bin..."
mkdir -p "$HOME/.local/bin"

cat > "$HOME/.local/bin/elfie-daemon" <<EOF
#!/usr/bin/env bash
exec python3 "$DAEMON_DIR/elfie_daemon.py" "\$@"
EOF
chmod +x "$HOME/.local/bin/elfie-daemon"

cp "$DAEMON_DIR/elfie" "$HOME/.local/bin/elfie"
chmod +x "$HOME/.local/bin/elfie"

echo ""
echo "✓ Instalado!"
echo ""
echo "IMPORTANTE: faça logout e login novamente (ou reinicie) para o grupo 'input' ter efeito."
echo ""
echo "Uso:"
echo "  elfie-daemon &          # sobe o daemon em background"
echo "  elfie switch <chatId>   # define qual chat usar"
echo "  elfie status            # vê o estado"
echo "  elfie stop              # encerra"
echo "  [F9]                    # toggle mute"
