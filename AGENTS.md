# AGENTS.md

Guidance for AI coding agents (Claude, Codex, etc.) working in this repo. Humans are
welcome to read it too. This is the single source of truth for how we work here; the
per-area READMEs hold the technical detail (don't duplicate them — link to them).

## What this project is (the vision)

**web-terminal** is a browser-based, **persistent** SSH terminal. A user logs in as an
ordinary SSH user; their terminals live in **tmux** on the host, so the *same* sessions are
reachable from the web UI **and** from a plain `ssh … tmux attach`. It is self-hostable and
open source.

Goals, in priority order:
1. **Real and persistent** — actual SSH + tmux, sessions survive disconnects, identical in
   web and SSH.
2. **Simple to run and to read** — one image, one launcher (`deploy/run-local.sh`), a small
   codebase a newcomer can understand in an afternoon.
3. **Secure by default** — loopback HTTP for convenience, HTTPS elsewhere; never log/store
   passwords; sane production hardening documented.
4. **Small and focused** — a terminal, not a platform. Resist scope creep.

## Architecture (orient yourself, then read the READMEs)

| Piece | Where | Detail |
| --- | --- | --- |
| Web app — TanStack Start + React + xterm.js (routes are `ssr:false`) | `src/` | [README.md](README.md) |
| Gateway — a **separate** Node process (`ws` + `ssh2` + tmux) | `server/` | [server/README.md](server/README.md) |
| Deployment — Podman/Docker, Caddy, systemd Quadlet | `deploy/` | [deploy/README.md](deploy/README.md) |

- The gateway is deliberately separate from the web app because TanStack Start can't reliably
  serve WebSocket upgrades. The browser and gateway share **one** wire/layout definition in
  `server/protocol.ts` (single source of truth for the protocol).
- Model: **Desktop = tmux session**, **terminal = tmux window**; the web tabs/splits are a
  best-effort presentation layer persisted per-user in a JSON sidecar.
- Security policy & threat model: [SECURITY.md](SECURITY.md). Dev/contrib flow:
  [CONTRIBUTING.md](CONTRIBUTING.md).

## Core principles

These guide every change. When two principles tension each other, say so and reason it out.

- **Single source of truth** — no duplicate data sources or files that do the same thing.
  When refactoring or making a new version of something, **suggest removing the old code**
  so we don't get confused about which file does what — unless explicitly told not to make
  breaking changes.
- **KISS** — we must still understand this codebase in 6–24 months. The simplest approach is
  usually best; before implementing, ask "is there a simpler way?"
- **Low risk, high impact** — weigh multiple scenarios and their risk; almost always pick the
  lowest-risk route with the highest impact.
- **DRY** — if the same thing is done in two places, consider generalizing it. Balance against
  overcomplicating: rather a little too late than too soon.
- **Separation of concerns / single responsibility** — stay modular and organized without
  overcomplicating; again, rather too late than too soon.
- **Work with the language, not against it** — for JS/TS that means a **functional** style
  (functions over classes); follow how the language was designed to be used.
- **Modify/augment rather than delete-and-recreate** — to avoid losing the thread, prefer to
  MOVE or COPY a file then modify it (via CLI) over reading and regenerating it. (Exception:
  when a file's whole foundation changes, a rewrite can be justified — state why.)
- **Sanity-check yourself** — after finishing a task (especially after a plan), reason about
  what you did, then pick a random changed file/todo and peer-review it as if it were a
  colleague's PR. Parallel edits and subagents introduce mistakes; catch them.
- **State rationale and assumptions** — be transparent about your reasoning and what you
  assumed, every interaction. If uncertain, say so and look it up (file/web search).
- **Update docs** — when you change something that's documented, check whether the docs need
  updating too.
- **No premature optimization** — don't add caches or speed/"fancy" features unless explicitly
  asked. Simplicity first.
- **Know the tooling** — check `package.json`/READMEs for available lint/type/test tools, and
  run them after making file changes before reporting back, so everything meets our standards.

## Commands

```sh
npm run dev            # web app (Vite); proxies /ws and /auth to the gateway
npm run gateway:dev    # the ssh2+tmux gateway (separate process)
npm run lint           # eslint + prettier — must be 0 errors AND 0 warnings
npm run format         # prettier --write
npm run gateway:typecheck   # tsc -p server
npm run gateway:test        # pure gateway unit tests (no sshd needed)
npm run build          # client + SSR (Nitro) build -> .output/server/index.mjs
```

Run lint + the relevant typecheck/tests/build after any change, and (for terminal/gateway
work) verify end-to-end against a real sshd+tmux target — `deploy/run-local.sh` or the Podman
test recipe in `server/README.md`. There is intentionally **no CI**; verification is manual.

## Hard-won gotchas (don't rediscover these)

- **tmux `-F` separators must be printable.** tmux replaces control chars in format output
  (a tab comes back as `_`), so the field separator is `|`, and the parsers split on it.
- **Never `destroy-unattached` a *detached* tmux session** — tmux destroys it immediately, so
  the subsequent `attach` fails (`can't find session`). Viewers are cleaned up explicitly.
- **`crypto.randomUUID()` is secure-context-only** — it's `undefined` over `http://<LAN-IP>`.
  Don't use it client-side; use a context-independent id.
- **TanStack Start can't reliably serve WebSockets** — hence the separate gateway. The app
  build needs the `nitro()` Vite plugin to emit a runnable Node server (`.output/server/index.mjs`).
- **Docker reads `.dockerignore`, Podman reads `.containerignore`** — both exist and must stay
  in sync; without the Docker one, `COPY . .` clobbers the image's Linux `node_modules`.
- The eval launcher generates a **self-signed cert once** (in `deploy/certs/`, gitignored);
  rebuilds don't regenerate it.
