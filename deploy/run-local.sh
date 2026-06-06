#!/usr/bin/env bash
# Local end-to-end run of the web-terminal stack in Podman (or Docker).
#
# Secure-by-default networking:
#   - loopback (http://localhost:HTTP_PORT) is plain HTTP (convenient; local only),
#   - everything else is HTTPS on :HTTPS_PORT with a self-signed cert generated on first
#     start. The HTTP port is published to 127.0.0.1 only, so the LAN can ONLY reach HTTPS.
#
# The gateway SSHes into THIS HOST (your real user accounts). The host must:
#   - run sshd,
#   - have tmux installed,
#   - allow password authentication (PasswordAuthentication yes) for those users.
#
#   deploy/run-local.sh          # build + start everything; prints the URLs
#   deploy/run-local.sh down     # stop + remove everything
#
# Override defaults via env: ENGINE, HTTP_PORT, HTTPS_PORT, NETWORK, IMAGE, SSH_HOST, SSH_PORT.
set -euo pipefail

# Pick a container engine (prefer podman; fall back to docker).
ENGINE="${ENGINE:-}"
if [ -z "$ENGINE" ]; then
  if command -v podman >/dev/null 2>&1; then ENGINE=podman
  elif command -v docker >/dev/null 2>&1; then ENGINE=docker
  else echo "error: neither podman nor docker found on PATH" >&2; exit 1; fi
fi

NETWORK="${NETWORK:-webterm}"
IMAGE="${IMAGE:-webterm}"
# Persists per-user pane layout (splits/zoom/tabs) across container recreate + image rebuild.
# A named volume survives `down` (which removes only containers+network), unlike the
# container's ephemeral layer where the gateway would otherwise write ~/.web-terminal/layouts.
LAYOUT_VOL="${LAYOUT_VOL:-webterm-layouts}"
LAYOUT_DIR_IN_CONTAINER=/var/lib/web-terminal/layouts
HTTP_PORT="${HTTP_PORT:-8080}"     # loopback-only plain HTTP
HTTPS_PORT="${HTTPS_PORT:-8443}"   # HTTPS (self-signed) on all interfaces
# Host the gateway connects to over SSH. host.containers.internal = this machine.
SSH_HOST="${SSH_HOST:-host.containers.internal}"
SSH_PORT="${SSH_PORT:-22}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="$ROOT/deploy/certs"
NAMES=(webterm-proxy webterm-gateway webterm-app webterm-sshd)

remove_containers() {
  for n in "${NAMES[@]}"; do "$ENGINE" rm -f "$n" >/dev/null 2>&1 || true; done
}

if [ "${1:-up}" = "down" ]; then
  echo "==> Stopping and removing the stack…"
  remove_containers
  "$ENGINE" network rm "$NETWORK" >/dev/null 2>&1 || true
  echo "Done. (Self-signed cert kept in deploy/certs — delete it to regenerate.)"
  echo "      (Layout volume '$LAYOUT_VOL' kept so a restart preserves splits/zoom —"
  echo "       purge with: $ENGINE volume rm $LAYOUT_VOL)"
  exit 0
fi

echo "==> Engine: $ENGINE"
echo "==> Gateway will SSH to: $SSH_HOST:$SSH_PORT"
echo "    (that host needs sshd running, tmux installed, and PasswordAuthentication yes)"

# --- self-signed cert for HTTPS (generated once; covers loopback + this host's IPs) ---
if [ ! -f "$CERT_DIR/webterm.crt" ] || [ ! -f "$CERT_DIR/webterm.key" ]; then
  command -v openssl >/dev/null 2>&1 || {
    echo "error: openssl is required to generate the HTTPS cert (install it and retry)" >&2
    exit 1
  }
  mkdir -p "$CERT_DIR"
  san="DNS:localhost,IP:127.0.0.1"
  hn="$(hostname 2>/dev/null || true)"
  [ -n "$hn" ] && san="$san,DNS:$hn"
  for ip in $(hostname -I 2>/dev/null || true); do san="$san,IP:$ip"; done
  echo "==> Generating self-signed cert (SAN: $san)…"
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 \
    -keyout "$CERT_DIR/webterm.key" -out "$CERT_DIR/webterm.crt" \
    -subj "/CN=web-terminal" -addext "subjectAltName=$san" >/dev/null 2>&1
  chmod 600 "$CERT_DIR/webterm.key"
fi

echo "==> Cleaning any previous run…"
remove_containers

echo "==> Network: $NETWORK"
"$ENGINE" network inspect "$NETWORK" >/dev/null 2>&1 || "$ENGINE" network create "$NETWORK"

echo "==> Layout volume: $LAYOUT_VOL (persists pane layout across restart/rebuild)"
"$ENGINE" volume inspect "$LAYOUT_VOL" >/dev/null 2>&1 || "$ENGINE" volume create "$LAYOUT_VOL" >/dev/null

# Always build. Layer caching makes an unchanged rebuild nearly instant (npm ci / npm run
# build only re-run when their inputs change) and needs no network on a cache hit, so a
# reboot is fast while a `git pull` is picked up automatically on the next run/restart.
echo "==> Building app+gateway image ($IMAGE)… (cached layers reused; first build pulls the node base image)"
"$ENGINE" build -t "$IMAGE" -f "$ROOT/Containerfile" "$ROOT"

# --restart unless-stopped: the engine restarts a crashed container on its own.
echo "==> Starting app…"
"$ENGINE" run -d --name webterm-app --network "$NETWORK" --restart unless-stopped \
  -e PORT=3000 "$IMAGE" >/dev/null

echo "==> Starting gateway (SSH -> $SSH_HOST:$SSH_PORT)…"
# --add-host maps host.containers.internal to the host even on a user-defined network.
"$ENGINE" run -d --name webterm-gateway --network "$NETWORK" --restart unless-stopped \
  --add-host=host.containers.internal:host-gateway \
  -e GATEWAY_BIND=0.0.0.0 -e SSH_HOST="$SSH_HOST" -e SSH_PORT="$SSH_PORT" \
  -e LAYOUT_DIR="$LAYOUT_DIR_IN_CONTAINER" \
  -v "$LAYOUT_VOL:$LAYOUT_DIR_IN_CONTAINER" \
  "$IMAGE" npm run gateway:start >/dev/null

echo "==> Starting reverse proxy (HTTP 127.0.0.1:${HTTP_PORT}, HTTPS :${HTTPS_PORT})…"
"$ENGINE" run -d --name webterm-proxy --network "$NETWORK" --restart unless-stopped \
  -p "127.0.0.1:${HTTP_PORT}:80" \
  -p "${HTTPS_PORT}:443" \
  -v "$ROOT/deploy/Caddyfile.local:/etc/caddy/Caddyfile:ro,Z" \
  -v "$CERT_DIR:/certs:ro,Z" \
  docker.io/library/caddy:2 >/dev/null

HOST_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
[ -z "$HOST_IP" ] && HOST_IP="<this-host-ip>"

cat <<EOF

✅ Stack is up.

   Loopback (this machine): http://localhost:${HTTP_PORT}
   LAN (other machines):    https://${HOST_IP}:${HTTPS_PORT}
       (self-signed — your browser warns once; click through. Plain HTTP is NOT exposed to
        the LAN. Open the host firewall for tcp/${HTTPS_PORT}.)

   Login: a REAL account on ${SSH_HOST} (your host username + password)

Verify:
  1. A live shell on the host appears and commands run (whoami = your user).
  2. Same tmux session from the host itself:
       tmux attach -t web-<your-username>-1
  3. Split a pane, resize it, reload the page -> layout persists. It also survives a
     restart/rebuild now (layouts live in the '$LAYOUT_VOL' volume, not the container).

If login fails, the usual causes are: host sshd has PasswordAuthentication off,
tmux not installed on the host, or a host firewall blocking the container subnet.
Gateway logs:
  $ENGINE logs webterm-gateway

Stop everything:
  deploy/run-local.sh down
EOF
