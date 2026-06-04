# Security policy

`web-terminal` is a **credential-handling network service**: the gateway authenticates a
user with their SSH username + password and opens a real SSH session (and tmux) on the
target host as that user. Treat any deployment as security-sensitive.

## Reporting a vulnerability

Please report privately via **GitHub Security Advisories** ("Security" tab → "Report a
vulnerability") rather than a public issue. We'll acknowledge and work on a fix before any
public disclosure.

## Threat model (what the gateway does)

- It is a separate Node process (`server/`) that opens an `ssh2` connection per logged-in
  user and streams a tmux pane to the browser over a WebSocket.
- The SSH **password** is used only to establish the connection and is never stored or
  logged. The session is tracked by an opaque `HttpOnly; SameSite=Strict` cookie mapping to
  the live connection (an in-memory registry).

## Hardening checklist (production)

- **TLS everywhere** — terminate HTTPS/`wss` at the reverse proxy; set a real domain
  (`SITE_ADDRESS`) so Caddy provisions a trusted cert.
- **`SSH_KNOWN_HOSTS`** — pin the target host key (the gateway refuses to start in
  production without it).
- **`ALLOWED_ORIGIN`** — restrict the WebSocket/auth origin (anti-CSWSH).
- **`COOKIE_SECURE=true`** in production (HTTPS only).
- **Bind the gateway to `127.0.0.1`** behind the reverse proxy; never expose `:8081`
  directly.
- Keep auth **rate-limiting** on; watch logs for brute-force attempts.

See [`deploy/README.md`](deploy/README.md) for the full production setup.

## Known limitations / non-goals

- **Password auth only** — no SSH keys, MFA, or keyboard-interactive.
- The easy `deploy/run-local.sh` path uses a **self-signed** cert for LAN access (browser
  warning) and trust-on-first-use host keys — for evaluation, not production.
- The connection registry is **in-memory / single-instance** (no HA; a gateway restart
  drops sessions, though tmux on the host persists them).
