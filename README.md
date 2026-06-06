<img width="1024" height="547" alt="image" src="https://github.com/user-attachments/assets/95d8e825-4f98-4762-bfa7-225c0d5082c3" />


# Web Terminal

A browser-based, **persistent** SSH terminal. You log in as an ordinary SSH user; your
terminals live in **tmux** on the host, so the same sessions are reachable from the web UI
**and** from a plain `ssh … tmux attach`. Desktops map to tmux sessions and tabs to tmux
windows; the web split layout is a best-effort presentation persisted per user.

## Pieces

- **Web app** — TanStack Start + React + xterm.js (`src/`). Build/serve via Nitro
  (`npm run build` → `node .output/server/index.mjs`).
- **Terminal gateway** — a standalone Node service (`ws` + `ssh2` + tmux) in `server/`,
  separate from the web app. See **[`server/README.md`](server/README.md)**.
- **Deploy** — Podman/Docker containers + a Caddy reverse proxy + a one-command systemd boot installer. See
  **[`deploy/README.md`](deploy/README.md)**.

## Quick start (local eval, all in Podman/Docker)

```sh
deploy/run-local.sh                 # builds + starts the stack; gateway SSHes into THIS host
# open http://localhost:8080 and log in with a real host account
deploy/run-local.sh down            # tear it down
```

The target host must run `sshd`, have `tmux` installed, and allow **password** auth.
The script serves loopback over plain HTTP and the LAN over **HTTPS** with a self-signed
cert (generated on first start; browsers warn once). Other machines use
`https://<host-ip>:8443`. Full details + the systemd boot installer in
[`deploy/README.md`](deploy/README.md).

## Development

```sh
npm run dev          # web app (Vite); proxies /ws and /auth to the gateway
npm run gateway:dev  # terminal gateway (separate process)
```

Checks: `npm run lint`, `npm run gateway:typecheck`, `npm run gateway:test`.

## Terminal keys & clipboard

- **Shift+Enter** inserts a newline (sends `LF`, like `Ctrl+J`) instead of submitting —
  handy in multi-line prompts (e.g. Claude Code). Plain **Enter** still submits.
- **Copy** works two ways: apps that use **OSC 52** (e.g. Claude Code, neovim) copy
  straight to your browser clipboard; for a manual selection, hold **Shift** while
  dragging (to bypass an app's mouse capture) then **Cmd+C** / **Ctrl+Shift+C**. Plain
  **Ctrl+C** is left untouched so it still sends `SIGINT`.
- Browser-clipboard writes need a **secure context** — i.e. HTTPS or `localhost`.
- **URLs are clickable** (web-links addon), and **inline images** (sixel / iTerm) render
  in-terminal (image addon).
