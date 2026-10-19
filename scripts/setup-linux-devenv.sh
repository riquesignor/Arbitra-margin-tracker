#!/usr/bin/env bash
# Roda em cada máquina Linux nova antes de mexer no projeto.
#
# O projeto vive num pen drive exFAT (para ser portátil entre Windows e Linux),
# mas exFAT não suporta symlinks — e o npm precisa criar symlinks em
# node_modules/.bin. Este script monta (bind mount) uma pasta node_modules
# real, guardada no disco interno do Linux, por cima da pasta node_modules
# do projeto no pen drive. O código-fonte continua só no pen drive; apenas
# as dependências instaladas ficam fora dele nesta máquina.
#
# Precisa rodar de novo (é rápido, é um mount) toda vez que você reconectar
# o pen drive numa máquina Linux, porque o bind mount não sobrevive a reboot
# nem a desplugar o drive.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_NAME="$(basename "$PROJECT_DIR")"
CACHE_DIR="$HOME/.cache/pendrive-node-modules/$PROJECT_NAME"
TARGET="$PROJECT_DIR/node_modules"

mkdir -p "$CACHE_DIR" "$TARGET"

if mountpoint -q "$TARGET"; then
  echo "node_modules já está montado em $TARGET"
else
  echo "Montando node_modules ($CACHE_DIR -> $TARGET), vai pedir sua senha (sudo)..."
  sudo mount --bind "$CACHE_DIR" "$TARGET"
fi

cd "$PROJECT_DIR"

# Versão do Node vem do .nvmrc (mesma fonte da CI). Máquina nova costuma ter
# Node antigo do sistema (já apareceu Node 10 via snap), que quebra o npm
# install com erro confuso — melhor parar aqui com a mensagem certa.
REQUIRED_NODE_MAJOR="$(tr -dc '0-9' < .nvmrc)"
if [ -s "$HOME/.nvm/nvm.sh" ]; then
  set +u
  # shellcheck disable=SC1091
  . "$HOME/.nvm/nvm.sh"
  nvm install >/dev/null && nvm use >/dev/null
  set -u
fi
CURRENT_NODE_MAJOR="$(node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || echo 0)"
if [ "${CURRENT_NODE_MAJOR:-0}" -lt "$REQUIRED_NODE_MAJOR" ]; then
  echo "Node $REQUIRED_NODE_MAJOR+ necessário (encontrado: $(node -v 2>/dev/null || echo nenhum))." >&2
  echo "Instale o nvm (https://github.com/nvm-sh/nvm) e rode este script de novo." >&2
  exit 1
fi

echo "Instalando dependências (Node $(node -v))..."
npm install

echo "Pronto. node_modules real está em: $CACHE_DIR"
