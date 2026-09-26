#!/usr/bin/env bash
# Roda UMA VEZ em cada máquina Linux (pede sudo, só nesta vez).
#
# Depois de rodado, toda vez que este pen drive for plugado nesta máquina,
# o node_modules do projeto é conectado automaticamente a uma pasta local
# (fora do exFAT) via udev + systemd — sem rodar comando nenhum nem digitar
# senha de novo.
#
# Por que udev (e não um systemd .path)? O projeto fica numa pasta que já
# existe o tempo todo enquanto o drive está plugado, então um .path
# (PathExists) fica re-disparando sem parar e o systemd bloqueia por excesso
# de tentativas. udev dispara certo: uma vez por evento de "dispositivo
# conectado", não enquanto a condição continuar verdadeira.
#
# Arquivos criados (para desinstalar, apague os 3):
#   /etc/udev/rules.d/99-pendrive-nodemodules-<projeto>.rules
#   /etc/systemd/system/pendrive-nodemodules-<projeto>.service
#   /usr/local/bin/pendrive-nodemodules-<projeto>-mount.sh
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PROJECT_NAME="$(basename "$PROJECT_DIR")"
CURRENT_USER="${SUDO_USER:-$USER}"
USER_HOME="$(getent passwd "$CURRENT_USER" | cut -d: -f6)"
CACHE_DIR="$USER_HOME/.cache/pendrive-node-modules/$PROJECT_NAME"
TARGET="$PROJECT_DIR/node_modules"
UNIT="pendrive-nodemodules-$PROJECT_NAME"

# Descobre o dispositivo de bloco por trás da pasta do projeto, e o UUID
# do sistema de arquivos dele (identifica o pen drive de forma estável,
# independente de em qual /dev/sdX ele aparecer da próxima vez).
DEVICE="$(df --output=source "$PROJECT_DIR" | tail -1)"
FS_UUID="$(udevadm info --query=property --name="$DEVICE" | sed -n 's/^ID_FS_UUID=//p')"

if [ -z "$FS_UUID" ]; then
  echo "Não consegui identificar o UUID do sistema de arquivos do pen drive em $DEVICE." >&2
  echo "Rode 'lsblk -f' e me diga o que aparece pra esse drive." >&2
  exit 1
fi

echo "Projeto:      $PROJECT_DIR"
echo "Usuário:      $CURRENT_USER"
echo "Cache local:  $CACHE_DIR"
echo "Dispositivo:  $DEVICE (UUID $FS_UUID)"
echo

# Remove instalação antiga baseada em .path, se existir (versão anterior deste script)
sudo systemctl disable --now "${UNIT}.path" 2>/dev/null || true
sudo rm -f "/etc/systemd/system/${UNIT}.path" "/etc/systemd/system/multi-user.target.wants/${UNIT}.path"

sudo mkdir -p "$CACHE_DIR"
sudo chown "$CURRENT_USER":"$CURRENT_USER" "$CACHE_DIR"

sudo tee "/usr/local/bin/${UNIT}-mount.sh" > /dev/null <<EOF
#!/bin/bash
set -e
TARGET="$TARGET"
CACHE="$CACHE_DIR"

# udisks2 monta o filesystem de forma assíncrona depois do evento de
# dispositivo conectado; espera até a pasta do projeto aparecer (até 30s).
for i in \$(seq 1 30); do
  [ -f "$PROJECT_DIR/package.json" ] && break
  sleep 1
done

mkdir -p "\$TARGET"
if ! mountpoint -q "\$TARGET"; then
  mount --bind "\$CACHE" "\$TARGET"
fi
EOF
sudo chmod +x "/usr/local/bin/${UNIT}-mount.sh"

sudo tee "/etc/systemd/system/${UNIT}.service" > /dev/null <<EOF
[Unit]
Description=Bind mount node_modules for $PROJECT_NAME (pen drive)

[Service]
Type=oneshot
ExecStart=/usr/local/bin/${UNIT}-mount.sh
EOF

sudo tee "/etc/udev/rules.d/99-${UNIT}.rules" > /dev/null <<EOF
SUBSYSTEM=="block", ENV{ID_FS_UUID}=="$FS_UUID", ENV{SYSTEMD_WANTS}+="${UNIT}.service", TAG+="systemd"
EOF

sudo systemctl daemon-reload
sudo udevadm control --reload-rules

echo
echo "Pronto! A partir de agora, sempre que este pen drive for plugado nesta"
echo "máquina, o node_modules é conectado sozinho, sem comando nenhum."
echo
echo "Observação: antes de tirar o pen drive, ejete pela interface do sistema"
echo "(clique direito > ejetar/desmontar) em vez de arrancar direto. Como o"
echo "node_modules fica 'colado' na pasta, uma remoção brusca pode deixar o"
echo "sistema reclamando de mount ocupado."
