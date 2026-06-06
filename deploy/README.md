# Deploying the web terminal with Podman

Two container roles from **one image** (`Containerfile`): the **app** (Nitro web server)
and the **gateway** (ssh2 + tmux WebSocket). A **Caddy** reverse proxy terminates TLS and
routes `/ws` + `/auth` to the gateway and everything else to the app. The gateway then
SSHes into a host running `sshd` + `tmux` (your real host in prod; a throwaway container
for testing).

> `podman` and `docker` CLIs are interchangeable for everything here. `Containerfile` is
> Podman's native name (Docker reads it too).

```
browser ──https──> Caddy (webterm-proxy)
                     ├── /ws, /auth ──> webterm-gateway :8081 ──ssh2──> sshd + tmux (host)
                     └── everything ──> webterm-app     :3000
```

---

## A. Quick evaluation on a Linux box (gateway → this host)

The gateway SSHes into **the host you run this on**, using a real user account. That host
must run `sshd`, have `tmux` installed, and allow **password** auth
(`PasswordAuthentication yes` in `/etc/ssh/sshd_config`, then `systemctl reload sshd`).

### Easiest: the helper script

```sh
git clone git@github.com:carlhannes/web-terminal.git && cd web-terminal
deploy/run-local.sh            # builds images + starts the stack (gateway -> this host)
# ... open http://localhost:8080, log in with YOUR host username + password ...
deploy/run-local.sh down       # tear it all down
```

Prefers `podman` (falls back to `docker`), idempotent, prints the URL + verify hints.
Override with env, e.g. `HTTP_PORT=9000 SSH_HOST=10.0.0.5 deploy/run-local.sh`.

### Or the same thing by hand

```sh
podman network create webterm

# build the app+gateway image
podman build -t webterm .

# app (no published port — only the proxy is public)
podman run -d --name webterm-app --network webterm -e PORT=3000 webterm

# gateway -> this host's sshd. host.containers.internal maps to the host; --add-host makes
# it resolve even on a user-defined network; bind 0.0.0.0 so the proxy can reach it.
podman run -d --name webterm-gateway --network webterm \
  --add-host=host.containers.internal:host-gateway \
  -e GATEWAY_BIND=0.0.0.0 -e SSH_HOST=host.containers.internal -e SSH_PORT=22 \
  webterm npm run gateway:start

# proxy on http://localhost:8080 (plain HTTP is fine for local eval)
podman run -d --name webterm-proxy --network webterm -p 127.0.0.1:8080:80 \
  -e SITE_ADDRESS=:80 \
  -v "$PWD/deploy/Caddyfile:/etc/caddy/Caddyfile:ro,Z" \
  docker.io/library/caddy:2
```

Open **http://localhost:8080**, log in with your host username + password → a live shell
on the host.

### Verify it's real + persistent
```sh
# on the host, attach the SAME tmux session the browser is showing:
tmux attach -t web-<your-username>-1
```
- A window created with `tmux new-window` on the host appears as a browser tab within ~2s.
- Split a pane in the browser, resize it, reload → the split + sizes return (sidecar).
- Wrong password → rejected; repeated tries → rate-limited.

> Prefer a throwaway box over the real host? Build `deploy/test-sshd` and set
> `SSH_HOST=webterm-sshd` (see [`server/README.md`](../server/README.md)).

### Tear down
```sh
deploy/run-local.sh down
```

---

## B. Run on boot (systemd — any engine)

Register the stack to start automatically on boot. One command, works with podman **or**
docker, rootful or rootless:

```sh
deploy/install-service.sh            # install + enable + start web-terminal.service
deploy/install-service.sh uninstall  # remove it
```

- As **root** → a system service (`/etc/systemd/system`); starts at boot for everyone.
- As a **regular user** → a user service (`~/.config/systemd/user`) + `loginctl enable-linger`;
  starts at boot for you (rootless-Podman best practice).

It wraps `deploy/run-local.sh`, so the same secure-by-default networking applies (loopback
HTTP + self-signed LAN HTTPS). The first start builds the image (minutes — the unit sets
`TimeoutStartSec=0`); later starts reuse the layer cache, so an unchanged reboot is fast and a
`git pull` is rebuilt automatically on the next restart.

**Configure without editing the unit:** put `KEY=VALUE` lines in `deploy/service.env` (copy
what you need from `.env.example`), then `systemctl [--user] restart web-terminal`:

```sh
# deploy/service.env  (example for a real host)
SSH_HOST=host.containers.internal      # or the host's LAN IP
HTTPS_PORT=8443
```

> **A reboot signs everyone out** — the gateway holds each live SSH connection in memory and
> never stores your password, so the pre-reboot session can't be resumed. Just log in again;
> your tmux desktops are intact, and your **web layout (splits, zoom, tab grouping) persists
> too** (see below). If a *fresh* login then fails, see
> [Troubleshooting](#troubleshooting-login-fails-after-a-reboot) below.

**Layout persistence.** The gateway stores each user's pane layout as a JSON sidecar
(`LAYOUT_DIR`, default `~/.web-terminal/layouts`). A restart recreates the container and
rebuilds the image, so `run-local.sh` mounts a **named volume `webterm-layouts`** at
`/var/lib/web-terminal/layouts` (with `LAYOUT_DIR` pointed there) — splits/zoom/tabs survive
`restart`, `down`/`up`, and image rebuilds. `down` keeps the volume on purpose (tmux itself
is the source of truth for *which* windows exist; this only remembers their web arrangement).

```sh
podman volume export webterm-layouts > layouts.tar   # back up
podman volume import webterm-layouts layouts.tar      # restore
podman volume rm     webterm-layouts                  # purge (resets everyone's layout)
```

### Production with a real domain (trusted cert)

The boot service serves a **self-signed** cert (fine for LAN/IP). For a public domain with a
browser-trusted cert, front the app + gateway with a reverse proxy that does ACME —
`deploy/Caddyfile` is a ready template (set `SITE_ADDRESS=your-domain`; it routes `/ws`+`/auth`
→ gateway and everything else → app). Then set `NODE_ENV=production`, a pinned
`SSH_KNOWN_HOSTS` (`ssh-keyscan -p 22 your-host > /etc/webterm/known_hosts`), `COOKIE_SECURE=true`,
and `ALLOWED_ORIGIN=https://your-domain` in `deploy/service.env`.

---

## Troubleshooting: login fails after a reboot

A reboot does **not** keep you logged in (see the note above) — sign in again; your tmux
desktops persist. If the **fresh** login then fails, the gateway now names the cause. Read it:

```sh
journalctl --user -u web-terminal -e     # user service (drop --user if installed as root)
# or directly:  podman logs webterm-gateway
```

Find the `auth failed` line and check its `reason`:

- **`reason:"bad-credentials"`** — the host rejected the password. The usual reboot culprit is
  the host quietly resetting `PasswordAuthentication` to `no` (a cloud-image default or an
  unattended-upgrades rewrite of `sshd_config`). Make it stick with a drop-in that wins over
  the defaults:
  ```sh
  echo 'PasswordAuthentication yes' | sudo tee /etc/ssh/sshd_config.d/00-webterm.conf
  sudo systemctl reload ssh
  sudo sshd -T | grep -i passwordauthentication      # should print "yes"
  ```
- **`reason:"host-unreachable"`** — the gateway container can't reach the host's sshd. Check
  name resolution from inside the container: `podman exec webterm-gateway getent hosts
  host.containers.internal`. Rootless Podman has known *after-reboot* quirks here — Podman 5.0.0
  shipped an invalid IP for `host.containers.internal` (fixed in ≥5.0.1), and a stopped
  `netavark-dhcp-proxy.socket` breaks that name. The robust fix is to pin a stable address:
  ```sh
  echo 'SSH_HOST=10.0.0.5' >> deploy/service.env     # the host's real LAN IP
  systemctl --user restart web-terminal
  ```
  Also confirm a host firewall that reloaded at boot isn't blocking the container subnet on tcp/22.
- **`reason:"host-key"`** — the presented host key didn't match the pinned `SSH_KNOWN_HOSTS`
  (prod only). Re-pin if the host was rebuilt: `ssh-keyscan -p 22 your-host > /etc/webterm/known_hosts`.

## Networking & gotchas
- **Gateway → host sshd:** `SSH_HOST=host.containers.internal` reaches the Podman host. If
  it doesn't resolve in your Podman/networking setup, use the host's LAN IP, or add
  `--add-host=host.containers.internal:host-gateway` (the launcher already does this).
- **Gateway bind:** must be `GATEWAY_BIND=0.0.0.0` *inside* the container so the proxy can
  reach it. It stays private because the container's port is not published — only Caddy is.
- **Rootless Podman:** publish loopback (`-p 127.0.0.1:…`) and use ports >1024 for the proxy
  if not running as root; mount volumes with `:Z` for SELinux relabeling.
- **Reach it from the LAN (HTTPS by default):** `deploy/run-local.sh` always serves plain
  HTTP on `127.0.0.1:8080` (host-only) **and** HTTPS on `:8443` (all interfaces) with a
  self-signed cert generated on first start (in `deploy/certs/`, gitignored; needs
  `openssl`). LAN machines can only reach the HTTPS port, so SSH passwords are never sent in
  cleartext over the network:
  ```sh
  deploy/run-local.sh                              # prints http://localhost:8080 + https://<ip>:8443
  sudo firewall-cmd --add-port=8443/tcp            # firewalld;  or: sudo ufw allow 8443/tcp
  ```
  Browsers warn once on the self-signed cert (click through). To regenerate (e.g. the host
  IP changed): delete `deploy/certs/` and re-run. **No warning?** use a real domain (prod
  path below) or trust Caddy's CA on the client. Override ports with `HTTP_PORT`/`HTTPS_PORT`;
  rootless can't bind 80/443, so keep them high.
- **TLS / cookies:** the auth cookie is `SameSite=Strict` and (in prod) `Secure`, so prod
  must be HTTPS — set `SITE_ADDRESS=your-domain` (Caddy auto-provisions a cert) and
  `COOKIE_SECURE=true`. Plain HTTP only works for local eval (NODE_ENV unset).
- The host must allow **password** SSH auth for these users (no key-only / MFA), and tmux
  must be installed on it.

> Not verified in CI — these artifacts were authored against Podman's documented behavior
> but exercised by you on the target host. The pure app/gateway code is unit-tested and the
> Node server build is verified; the container/proxy/systemd wiring is what to sanity-check here.
