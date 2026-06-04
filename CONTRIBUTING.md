# Contributing

Thanks for your interest! This is a small, focused project — please keep changes simple and
well-scoped.

## Architecture (three pieces)

| Piece | Where | Docs |
| --- | --- | --- |
| Web app (React + xterm.js, TanStack Start) | `src/` | [README](README.md) |
| Terminal gateway (`ws` + `ssh2` + tmux), a separate Node process | `server/` | [server/README.md](server/README.md) |
| Deployment (Podman/Docker, Caddy, Quadlet) | `deploy/` | [deploy/README.md](deploy/README.md) |

The gateway and the browser share one wire/layout definition in `server/protocol.ts`
(single source of truth). The gateway is intentionally separate from the web app because
TanStack Start can't reliably serve WebSocket upgrades.

## Dev setup

```sh
npm install
npm run dev            # web app (Vite) — proxies /ws and /auth to the gateway
npm run gateway:dev    # the gateway, in a second terminal
```

The gateway needs an SSH host with `tmux` and password auth. For a throwaway target, see the
Podman test recipe in [server/README.md](server/README.md) (or run the whole stack with
`deploy/run-local.sh`).

## Before opening a PR

Run the checks (all must pass):

```sh
npm run lint            # eslint + prettier (0 errors, 0 warnings)
npm run format          # prettier --write
npm run gateway:typecheck
npm run gateway:test    # pure unit tests (no sshd needed)
npm run build           # client + SSR build
```

## Code style

- TypeScript, **functional** style (functions over classes where natural).
- Favor **KISS** and a **single source of truth** — prefer removing/clarifying over adding.
  No premature optimization (caches, etc.) unless there's a measured need.
- Match the surrounding code's conventions.

## Not yet (PRs welcome)

CI, an automated end-to-end (Docker sshd + tmux) test, SSH key/MFA auth, a `CODE_OF_CONDUCT`,
issue/PR templates, and release tagging are all intentionally absent for now.
