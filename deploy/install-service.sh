#!/usr/bin/env bash
# Register web-terminal to start on boot via systemd, by wrapping deploy/run-local.sh.
# Generic: works with podman or docker, rootful or rootless, on Ubuntu and similar.
# Run ONCE.
#
#   deploy/install-service.sh            # install + enable + start (builds on first start)
#   deploy/install-service.sh uninstall  # stop + disable + remove the unit
#
# Run as root  -> a system service (/etc/systemd/system), starts at boot for everyone.
# Run as a user -> a user service (~/.config/systemd/user) + linger, starts at boot for you.
#
# Configure the stack (SSH_HOST, HTTP_PORT, HTTPS_PORT, ENGINE, …) by putting KEY=VALUE
# lines in deploy/service.env (see .env.example), then restart the service.
set -euo pipefail

SERVICE="web-terminal"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN="$ROOT/deploy/run-local.sh"
ENV_FILE="$ROOT/deploy/service.env"

command -v systemctl >/dev/null 2>&1 || { echo "error: systemd (systemctl) not found" >&2; exit 1; }
[ -x "$RUN" ] || { echo "error: $RUN not found or not executable" >&2; exit 1; }

if [ "$(id -u)" = "0" ]; then
  MODE=system
  UNIT_DIR="/etc/systemd/system"
  WANTED_BY="multi-user.target"
  AFTER="network-online.target docker.service"
  SYSTEMCTL=(systemctl)
  JOURNAL=(journalctl)
else
  MODE=user
  UNIT_DIR="$HOME/.config/systemd/user"
  WANTED_BY="default.target"
  AFTER="network-online.target"
  SYSTEMCTL=(systemctl --user)
  JOURNAL=(journalctl --user)
fi
UNIT="$UNIT_DIR/$SERVICE.service"

uninstall() {
  "${SYSTEMCTL[@]}" disable --now "$SERVICE.service" 2>/dev/null || true
  rm -f "$UNIT"
  "${SYSTEMCTL[@]}" daemon-reload || true
  echo "Removed $SERVICE.service ($MODE)."
  echo "Containers are still running — stop them with: $RUN down"
  exit 0
}
[ "${1:-install}" = "uninstall" ] && uninstall

echo "==> Installing $SERVICE.service ($MODE) -> $UNIT"
mkdir -p "$UNIT_DIR"
cat > "$UNIT" <<EOF
[Unit]
Description=web-terminal (browser SSH terminal stack)
After=$AFTER
Wants=network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
# The first start builds the container image, which can take minutes.
TimeoutStartSec=0
WorkingDirectory=$ROOT
# Optional overrides (SSH_HOST, HTTP_PORT, …); '-' = fine if the file is absent.
EnvironmentFile=-$ENV_FILE
# Reuse the existing image on reboots instead of rebuilding (still builds if missing).
Environment=NO_BUILD=1
ExecStart=$RUN
ExecStop=$RUN down

[Install]
WantedBy=$WANTED_BY
EOF

"${SYSTEMCTL[@]}" daemon-reload
if [ "$MODE" = "user" ]; then
  # Make the user manager start at boot without an interactive login.
  loginctl enable-linger "$(id -un)" 2>/dev/null || \
    echo "warning: could not enable linger; the service may not start until you log in"
fi

echo "==> Enabling + starting (first start builds the image — this can take a few minutes)…"
"${SYSTEMCTL[@]}" enable --now "$SERVICE.service"

cat <<EOF

✅ $SERVICE.service installed ($MODE) and started; it will come back on every boot.

   Status:  ${SYSTEMCTL[*]} status $SERVICE.service
   Logs:    ${JOURNAL[*]} -u $SERVICE.service        # the URLs run-local.sh printed are here
   Config:  put SSH_HOST=…, HTTP_PORT=…, etc. in $ENV_FILE, then
            ${SYSTEMCTL[*]} restart $SERVICE.service
   Remove:  deploy/install-service.sh uninstall
EOF
