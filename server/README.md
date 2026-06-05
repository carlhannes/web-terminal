# Terminal gateway

A standalone Node service (`ws` + `ssh2`) that turns the web app into a real,
persistent SSH terminal backed by **tmux**. It is a separate process from the
TanStack Start app (whose Vite/srvx stack can't reliably do WebSocket upgrades).

## Model (single source of truth = tmux)

- **Desktop** = a tmux **session** named `web-<user>-<n>`.
- **Terminal** = a tmux **window** (reachable from a plain `tmux attach`).
- The web **tabs + resizable splits** are a *best-effort* presentation layer
  persisted per user in a JSON sidecar (`LAYOUT_DIR`). Windows with saved layout
  are restored to their spot; unknown windows surface as their own tab; dead ones
  are pruned (`reconcileLayout`).
- Each visible pane streams over one simple WebSocket stream (ttyd-style). To show
  several windows of one session side-by-side, each pane attaches a **grouped viewer
  session** (`tmux new-session -d -t <session> -s _v-…`, pinned to its window); the
  gateway kills that viewer when the pane closes. We deliberately do **not** use
  `destroy-unattached` (it would destroy the detached viewer before we can attach).
  tmux control mode (`-CC`) is intentionally NOT used (kept simple). The `exec tmux
  attach …` line is written to the login shell **space-prefixed** so it stays out of the
  user's shell history (relies on `HISTCONTROL=ignorespace`/`ignoreboth`).
- **Clipboard (OSC 52):** once per connection the gateway runs `set-option -g
  allow-passthrough on` and `set-option -g set-clipboard on` (`tmux.enableClipboard`, in
  `openViewer` after the session exists). `allow-passthrough` lets the tmux-wrapped OSC 52
  that apps emit under `$TMUX` (Claude Code, neovim) reach the attached client; tmux then
  forwards it down our pty → WebSocket → xterm, where the `@xterm/addon-clipboard` handler
  writes the browser clipboard. The transport carries it verbatim (raw binary output
  frames), so nothing else is needed gateway-side.

## Run

```sh
# 1) Web app (Vite) — proxies /ws and /auth to the gateway in dev:
npm run dev

# 2) Gateway (separate terminal):
npm run gateway:dev        # tsx watch
# prod: npm run gateway:start   (behind a TLS-terminating reverse proxy)
```

Configure via env (see `.env.example`). Key vars: `SSH_HOST`/`SSH_PORT`,
`SSH_KNOWN_HOSTS` (required in prod), `ALLOWED_ORIGIN` (required in prod),
`GATEWAY_PORT` (default 8081).

## Checks

```sh
npm run gateway:typecheck   # tsc -p server
npm run gateway:test        # pure unit tests (no sshd needed)
```

## End-to-end test with Podman (sshd + tmux)

There's no sshd/tmux on a typical dev mac, so spin up a throwaway target container
(`deploy/test-sshd/`), publish its port to localhost, and point the gateway at it:

```sh
podman build -t webterm-sshd deploy/test-sshd
podman run -d --name webterm-sshd -p 127.0.0.1:2222:22 webterm-sshd

# point the gateway at it (dev: NODE_ENV unset => host-key check is warn-only):
SSH_HOST=127.0.0.1 SSH_PORT=2222 npm run gateway:dev
```

Then `npm run dev`, open the app, log in with `demo` / `demo`.

### What to verify
1. Login → a live shell appears (type `ls`, it runs on the container).
2. From a real terminal: `ssh -p 2222 demo@127.0.0.1 -t tmux attach -t web-demo-1`
   → the same window(s) are there. Run `tmux new-window` from SSH → it shows up
   as a new tab in the web within ~2s (`LIST_POLL_MS`).
3. Split a pane in the web, resize it, reload the page → the split + sizes return
   (sidecar). A brand-new window with no saved layout appears as its own tab.
4. Close the browser tab, reopen → same sessions/scrollback (tmux persisted).
5. Wrong password → rejected; repeated wrong tries → rate-limited (429).

To run the **whole stack** (app + gateway + reverse proxy) and to start it on boot via a
one-command systemd installer, see [`deploy/README.md`](../deploy/README.md).
(`podman` and `docker` CLIs are interchangeable here.)

## Security (production)

- Put a TLS reverse proxy in front; the gateway binds `127.0.0.1` only.
- Set `SSH_KNOWN_HOSTS` (host-key pinning; gateway refuses to start without it in
  prod) and `ALLOWED_ORIGIN` (anti-CSWSH on the cookie-authenticated WS).
- Passwords are used only to open the ssh2 connection and are never stored or
  logged. The auth cookie is `HttpOnly; Secure; SameSite=Strict`.
