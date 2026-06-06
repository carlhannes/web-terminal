import { NAME_RE, type SessionInfo, type WindowInfo } from "./protocol";

// PURE tmux command builders + output parsers. No ssh2 / no IO here so this is
// unit-testable without a real host. The gateway runs these strings via ssh exec
// (control ops) or an ssh pty channel (the interactive viewer attach).
//
// SAFETY: every interpolated value is validated against NAME_RE / integer checks
// BEFORE being placed inside single quotes. Single quotes + the whitelist (which
// forbids quotes/spaces/`;`/`$`) close the command-injection boundary.

export function isValidName(n: string): boolean {
  return NAME_RE.test(n);
}

export function isWindowIndex(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= 0 && n < 100000;
}

/** Sanitize an SSH username into a tmux-safe token used in session names. */
export function sanitizeUser(user: string): string {
  return (
    user
      .toLowerCase()
      .replace(/[^a-z0-9_-]/g, "_")
      .slice(0, 32) || "user"
  );
}

/** Prefix that all of a user's desktop sessions share, e.g. "web-alice-". */
export function sessionPrefix(user: string, prefix: string): string {
  return `${prefix}-${sanitizeUser(user)}-`;
}

/** A session this user is allowed to operate on (their desktops only). */
export function ownsSession(session: string, user: string, prefix: string): boolean {
  return isValidName(session) && session.startsWith(sessionPrefix(user, prefix));
}

/** Lowest free desktop number for this user given existing session names. */
export function nextSessionName(existing: string[], user: string, prefix: string): string {
  const p = sessionPrefix(user, prefix);
  const used = new Set<number>();
  for (const s of existing) {
    if (s.startsWith(p)) {
      const n = Number(s.slice(p.length));
      if (Number.isInteger(n) && n > 0) used.add(n);
    }
  }
  let n = 1;
  while (used.has(n)) n++;
  return `${p}${n}`;
}

/** Viewer (grouped, self-destructing) sessions are named with this prefix and hidden from desktops. */
export const VIEWER_PREFIX = "_v-";

export function isViewerSession(name: string): boolean {
  return name.startsWith(VIEWER_PREFIX);
}

// Field separator for the -F formats. tmux REPLACES control characters (e.g. a tab) in
// format output, so a tab does not survive — it must be a printable char. "|" round-trips
// and never appears in the structured fields (ids, indexes, flags) or in session names
// (NAME_RE). A "|" inside a window NAME is handled by the middle-join in parseWindows.
const FIELD_SEP = "|";
const F_SESS = [
  "#{session_id}",
  "#{session_name}",
  "#{session_windows}",
  "#{session_created}",
].join(FIELD_SEP);
const F_WIN = ["#{window_id}", "#{window_index}", "#{window_name}", "#{window_active}"].join(
  FIELD_SEP,
);

// Command builders. `q` single-quotes a pre-validated token.
const q = (s: string) => `'${s}'`;

export const tmux = {
  listSessions: () => `tmux list-sessions -F '${F_SESS}' 2>/dev/null || true`,
  listWindows: (session: string) =>
    `tmux list-windows -t ${q(session)} -F '${F_WIN}' 2>/dev/null || true`,
  ensureSession: (session: string) =>
    `tmux has-session -t ${q(session)} 2>/dev/null || tmux new-session -d -s ${q(session)}`,
  newSession: (session: string) => `tmux new-session -d -s ${q(session)}`,
  killSession: (session: string) => `tmux kill-session -t ${q(session)}`,
  renameSession: (session: string, name: string) =>
    `tmux rename-session -t ${q(session)} ${q(name)}`,
  newWindow: (session: string, name?: string) =>
    `tmux new-window -t ${q(session)} ${name ? `-n ${q(name)} ` : ""}-P -F '#{window_id}'`,
  killWindow: (windowId: string) => `tmux kill-window -t ${q(windowId)}`,
  renameWindow: (windowId: string, name: string) =>
    `tmux rename-window -t ${q(windowId)} ${q(name)}`,

  /**
   * Create a (detached) grouped viewer session sharing `base`'s windows, pointed at the
   * target window index. We deliberately do NOT set `destroy-unattached` here: tmux
   * destroys a detached, never-attached session immediately when that option is on, which
   * would break the subsequent `attach` ("can't find session"). The gateway cleans the
   * viewer up explicitly when the pane's channel closes (killViewer). Run via ssh exec
   * (no pty); `\;` reaches tmux as a command separator.
   */
  viewerCreate: (base: string, viewer: string, windowIndex: number) =>
    `tmux new-session -d -t ${q(base)} -s ${q(viewer)} \\; ` +
    // `mouse on` (per-viewer, NOT global) so the web client's wheel scrolls tmux scrollback
    // instead of the alt-screen sending cursor-up to the shell. Isolated to this throwaway
    // viewer session, so the user's own CLI `tmux attach` to the base session is unaffected.
    `set-option -t ${q(viewer)} mouse on \\; ` +
    `select-window -t ${q(`${viewer}:${windowIndex}`)}`,

  /** Attach to the viewer interactively — run via an ssh pty channel; this is the stream. */
  viewerAttach: (viewer: string) => `tmux attach -t ${q(viewer)}`,

  killSessionQuiet: (session: string) => `tmux kill-session -t ${q(session)} 2>/dev/null || true`,

  /**
   * Let app clipboard (OSC 52) reach the attached client. `allow-passthrough on` unblocks
   * the tmux DCS wrapper apps use under $TMUX (e.g. Claude Code, neovim); `set-clipboard on`
   * makes tmux forward OSC 52 set-clipboard requests to the attached terminal (our pty ->
   * WebSocket -> xterm, where the clipboard addon writes the browser clipboard). Global,
   * idempotent; requires a running tmux server (run after ensureSession).
   */
  enableClipboard: () =>
    `tmux set-option -g allow-passthrough on \\; set-option -g set-clipboard on`,
};

// --------------------------- parsers ---------------------------

export function parseSessions(out: string): SessionInfo[] {
  return out
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const parts = line.split(FIELD_SEP);
      return {
        id: parts[0] ?? "",
        name: parts[1] ?? "",
        windows: Number(parts[2]) || 0,
        created: Number(parts[3]) || 0,
      };
    })
    .filter((s) => s.id && s.name);
}

export function parseWindows(out: string): WindowInfo[] {
  return out
    .split("\n")
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim().length > 0)
    .map((line) => {
      const parts = line.split(FIELD_SEP);
      // window_name (field 2) may itself contain the separator; id/index/active cannot,
      // so reconstruct the name from the middle fields (active is always last).
      const id = parts[0] ?? "";
      const index = Number(parts[1]) || 0;
      const active = parts[parts.length - 1] === "1";
      const name = parts.slice(2, parts.length - 1).join(FIELD_SEP);
      return { id, index, name, active };
    })
    .filter((w) => w.id);
}
