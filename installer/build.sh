#!/usr/bin/env bash
# Gera o ElfieSetup.exe a partir do Linux.
#
# O compilador do Inno Setup so roda em Windows, entao ele vem de container
# (amake/innosetup, que empacota o Inno sob Wine). Nao precisa de wine nem de
# Windows na maquina — so de Docker.
#
#   ./installer/build.sh            # compila
#   ./installer/build.sh --stage    # so monta installer/build/, nao compila
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
STAGE="$HERE/build"
DIST="$ROOT/dist"
IMAGE="amake/innosetup:latest"

STAGE_ONLY=0
[[ "${1:-}" == "--stage" ]] && STAGE_ONLY=1

echo "==> limpando $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE/app" "$DIST"

# O payload sai da ARVORE DE TRABALHO, nao de `git archive HEAD`: boa parte do
# codigo novo (platform_compat.py, overlay_win.py, elfie_inworld_call.py, os
# controllers novos da API) ainda nao esta commitada, e um instalador que
# empacota so o que ja foi commitado gera um bug de "no meu clone funciona".
copy_tree() {
  local src="$1" dst="$2"
  # A barra inicial ancora o padrao na RAIZ da copia (api/, elfie-web/, daemon/).
  # Sem ela, `models/` casaria com api/src/models — os models do Mongoose — e o
  # instalador sairia com a API sem Character.js/Settings.js/Workflow.js. So
  # node_modules fica solto de proposito, porque pode aparecer aninhado.
  rsync -a \
    --exclude 'node_modules/' \
    --exclude '.env' \
    --exclude '.env.local' \
    --exclude '__pycache__/' \
    --exclude '*.pyc' \
    --exclude '*.log' \
    --exclude '/dist/' \
    --exclude '/uploads/' \
    --exclude '/browser-profile/' \
    --exclude '/browser-extensions/' \
    --exclude '/hand_tracking_venv/' \
    --exclude '/models/' \
    "$src/" "$dst/"
}

echo "==> copiando a arvore do Elfie"
copy_tree "$ROOT/api"       "$STAGE/app/api"
copy_tree "$ROOT/elfie-web" "$STAGE/app/elfie-web"
copy_tree "$ROOT/daemon"    "$STAGE/app/daemon"

cp -r "$HERE/payload" "$HERE/assets" "$HERE/elfie.iss" "$STAGE/"

# Um instalador de distribuicao publica nao pode carregar chave de API de
# ninguem. As duas checagens abaixo sao baratas e pegam o erro antes do upload,
# nao depois — .env vaza por rsync mal ajustado e node_modules infla o exe de
# poucos MB pra varios GB sem ninguem perceber ate o build ficar lento.
if find "$STAGE/app" -name '.env' -print -quit | grep -q .; then
  echo "ERRO: um arquivo .env entrou no payload — ele levaria suas chaves junto." >&2
  exit 1
fi
if find "$STAGE/app" -type d -name node_modules -print -quit | grep -q .; then
  echo "ERRO: node_modules entrou no payload." >&2
  exit 1
fi

echo "==> payload: $(du -sh "$STAGE/app" | cut -f1) em $(find "$STAGE/app" -type f | wc -l) arquivos"

if [[ $STAGE_ONLY == 1 ]]; then
  echo "==> so a montagem foi pedida; parando aqui ($STAGE)"
  exit 0
fi

echo "==> compilando com $IMAGE"
docker run --rm \
  -v "$STAGE:/work" \
  -v "$DIST:/out" \
  "$IMAGE" \
  /work/elfie.iss "/O/out"

# O exe fica versionado em installer/ pra quem so quer baixar e instalar. Copiar
# aqui, e nao so no dist/ ignorado, e o que impede o binario commitado de ficar
# defasado em relacao ao codigo que ele empacota.
cp "$DIST/ElfieSetup.exe" "$HERE/ElfieSetup.exe"

echo ""
echo "==> pronto: $DIST/ElfieSetup.exe ($(du -h "$DIST/ElfieSetup.exe" | cut -f1))"
echo "==> copiado para installer/ElfieSetup.exe (versionado — lembre de commitar)"
