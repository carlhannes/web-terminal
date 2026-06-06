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
  allow-passthrough on` and `set-option -g set-clipboard on` (part of
  `tmux.configureServer`, in `openViewer` after the session exists). `allow-passthrough`
  lets the tmux-wrapped OSC 52 that apps emit under `$TMUX` (Claude Code, neovim) reach the
  attached client; tmux then forwards it down our pty → WebSocket → xterm, where the
  `@xterm/addon-clipboard` handler writes the browser clipboard. The transport carries it
  verbatim (raw binary output frames), so nothing else is needed gateway-side.
- **Mouse / scrollback / selection:** the viewer is created with
  `set-option -t <viewer> mouse on` (per-session, NOT `-g`) so the **wheel scrolls tmux's
  scrollback** — tmux runs on the alternate screen, so without this the wheel becomes
  cursor-up/down (cycling shell history). Scoped to the throwaway viewer, so a user's own
  CLI `tmux attach` keeps its setting. We do **not** want tmux's mouse *selection*, though
  (it auto-copies on release, and right-click pops a tmux menu), so `tmux.configureServer`
  also `unbind`s `MouseDrag1Pane` + `MouseDown3Pane` — a plain drag and right-click do
  nothing. **Native selection** is modifier+drag in xterm: **Option(⌥)+drag on macOS**
  (needs `macOptionClickForcesSelection: true` on the `Terminal`, set in `TerminalPane.tsx`),
  **Shift+drag elsewhere**, then Cmd/Ctrl+C — no auto-copy. (The unbinds are server-global
  but only fire where mouse is on, i.e. our viewer; mouse-off CLI sessions never see them.)

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

## Mock host (UI dev without SSH)

For UI work without an SSH host, run the **real gateway** with `MOCK_SSH=1` — only the
ssh2/host connection is faked, everything else is the real gateway:

```sh
npm run gateway:mock # = MOCK_SSH=1 tsx watch server/terminal-gateway.ts — log in with ANY creds
npm run dev:mock     # frontend pointed at the gateway on :8081 (sets the VITE_* URLs for you)
```

The seam is the `HostConnection` interface (`ssh-connection.ts`): the real `UserConnection`
talks to ssh2; `fake-host-connection.ts` (dev-only, dynamically imported, **forced off in
production** via `cfg.mockSsh`) emulates **only the remote host** — tmux (in the exact `-F`
format the parsers expect) and a fake shell that prints `This is not a real shell, for UI
testing purposes only` and answers every command with `<cmd>: command not found`.

Because the rest is real, this exercises the actual auth/WS, protocol dispatch, `tmux.ts`
command building + parsing, `reconcileLayout`, **the disk-backed `LayoutStore`** (so
splits/zoom persist for real), the registry timers, and window polling.

Dev note: `npm run dev`'s Vite `server.proxy` is inert (the Nitro dev server owns the
pipeline), so the browser talks to the gateway cross-origin on `:8081`. `dev:mock` just sets
the `VITE_TERMINAL_GATEWAY_HTTP_URL`/`_WS_URL` overrides for you, and `MOCK_SSH` mode adds
the matching dev-only CORS on `/auth` so that cross-origin call works (WebSockets aren't
CORS-gated). For true same-origin / dev↔prod parity, use `deploy/run-local.sh` (Caddy).

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
