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

## B. Production (systemd Quadlet)

In production the gateway points at your **real** host (real user accounts), not a
container. Quadlet runs the containers as systemd services (Podman's compose replacement).

```sh
# 1) build the image on the host (or pull from your registry)
podman build -t webterm .

# 2) install unit + config files (rootless example; rootful: /etc/containers/systemd/ and /etc/webterm/)
mkdir -p ~/.config/containers/systemd ~/.config/webterm
cp deploy/quadlet/webterm.network        ~/.config/containers/systemd/
cp deploy/quadlet/webterm-app.container  ~/.config/containers/systemd/
cp deploy/quadlet/webterm-gateway.container ~/.config/containers/systemd/
cp deploy/quadlet/webterm-proxy.container ~/.config/containers/systemd/
cp deploy/Caddyfile                      ~/.config/webterm/Caddyfile
cp deploy/quadlet/gateway.env.example    ~/.config/webterm/gateway.env   # then EDIT it

# 3) provide the pinned host key (required when NODE_ENV=production)
ssh-keyscan -p 22 your-ssh-host > ~/.config/webterm/known_hosts

# 4) set your domain in webterm-proxy.container (SITE_ADDRESS=) and ALLOWED_ORIGIN in gateway.env

# 5) start
systemctl --user daemon-reload
systemctl --user start webterm-proxy   # pulls up app + gateway via Requires=
```

Edit `~/.config/webterm/gateway.env` (template: `deploy/quadlet/gateway.env.example`):
set `SSH_HOST` (use `host.containers.internal` if sshd is on the Podman host), `NODE_ENV=production`,
`SSH_KNOWN_HOSTS=/etc/webterm/known_hosts`, `COOKIE_SECURE=true`, and
`ALLOWED_ORIGIN=https://your-domain`.

---

## Networking & gotchas
- **Gateway → host sshd:** `SSH_HOST=host.containers.internal` reaches the Podman host. If
  it doesn't resolve in your Podman/networking setup, use the host's LAN IP, or add
  `--add-host=host.containers.internal:host-gateway` (run) / `AddHost=` (Quadlet).
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
> Node server build is verified; the container/proxy/Quadlet wiring is what to sanity-check here.
