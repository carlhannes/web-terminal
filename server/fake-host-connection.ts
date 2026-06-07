/**
 * DEV-ONLY fake of the ssh2 host connection (HostConnection). Selected only when
 * `cfg.mockSsh` is true (MOCK_SSH=1 in dev; forced off in production) and dynamically
 * imported by the gateway so it never ships in the production path.
 *
 * It runs the REAL gateway end-to-end without an SSH host: only the remote machine (tmux +
 * the shell) is emulated in memory. `exec()` answers the tmux control commands the gateway
 * sends — in the exact `|`-separated format `parseSessions`/`parseWindows` expect — and
 * `openViewer()` returns a fake PTY stream whose "shell" prints a banner and replies to any
 * command with a POSIX-style "command not found". Everything above this (auth, WS, protocol
 * dispatch, tmux command building, layout-store disk persistence, registry, polling) is the
 * real gateway.
 */
import { EventEmitter } from "node:events";
import type { ClientChannel } from "ssh2";

import type { Dims, ExecResult, HostConnection } from "./ssh-connection";

const SEP = "|"; // mirrors tmux.ts FIELD_SEP (the -F format separator the parsers split on)
const BANNER = "This is not a real shell, for UI testing purposes only.\r\n$ ";
const PROMPT = "$ ";

interface FakeWindow {
  id: string;
  index: number;
  name: string;
  cwd: string;
  active: boolean;
}
interface FakeSession {
  id: string;
  created: number;
  windows: FakeWindow[];
}

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0 });

/** First single-quoted token after a flag, e.g. argAfter("-t", "… -t 'web-a-1' …"). */
function argAfter(flag: string, cmd: string): string | undefined {
  return cmd.match(new RegExp(`${flag}\\s+'([^']*)'`))?.[1];
}
/** Last single-quoted token (the new name in `rename-* -t 'X' 'NEW'`). */
function lastQuoted(cmd: string): string | undefined {
  const all = [...cmd.matchAll(/'([^']*)'/g)];
  return all.length ? all[all.length - 1][1] : undefined;
}

// A fake PTY: a line-buffered shell that echoes like a real PTY (xterm sends raw keystrokes
// with no local echo) and answers every command with "command not found".
class FakePaneStream extends EventEmitter {
  private line = "";
  private closed = false;

  constructor() {
    super();
    // Emit the banner on a later tick so it lands AFTER the gateway attaches its `data`
    // listener (it does so synchronously right after openViewer resolves). Mirrors a real
    // async ssh stream.
    setTimeout(() => this.out(BANNER), 0);
  }

  private out(text: string) {
    if (!this.closed) this.emit("data", Buffer.from(text, "utf8"));
  }

  write(data: string): boolean {
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        const cmd = this.line.trim();
        this.out("\r\n");
        if (cmd) this.out(`${cmd.split(/\s+/)[0]}: command not found\r\n`);
        this.out(PROMPT);
        this.line = "";
      } else if (ch === "\x7f") {
        if (this.line.length > 0) {
          this.line = this.line.slice(0, -1);
          this.out("\b \b");
        }
      } else if (ch === "\x03") {
        this.out("^C\r\n" + PROMPT);
        this.line = "";
      } else if (ch >= " ") {
        this.line += ch;
        this.out(ch);
      }
      // else: ignore other control chars / escape sequences (arrows, etc.)
    }
    return true;
  }

  setWindow(): void {
    /* no real PTY to resize */
  }

  end(): void {
    if (this.closed) return;
    this.closed = true;
    this.emit("close");
  }
}

export class FakeHostConnection implements HostConnection {
  readonly username: string;
  private sessions = new Map<string, FakeSession>();
  private sessSeq = 0;
  private winSeq = 0;
  private streams = new Set<FakePaneStream>();
  private closeCbs = new Set<() => void>();
  private closed = false;

  private constructor(username: string) {
    this.username = username;
  }

  /** Accepts any credentials (the /auth handler already rejected empty ones). */
  static connect(username: string): Promise<FakeHostConnection> {
    return Promise.resolve(new FakeHostConnection(username));
  }

  exec(command: string): Promise<ExecResult> {
    return Promise.resolve(this.run(command));
  }

  // Emulate the tmux control commands the gateway issues via conn.exec. (ensureSession /
  // viewerCreate / configureServer live inside the REAL openViewer, which we replace, so
  // they never reach here.) Order: match each distinct verb substring.
  private run(cmd: string): ExecResult {
    if (cmd.includes("list-sessions")) {
      const lines = [...this.sessions.entries()].map(
        ([name, s]) => `${s.id}${SEP}${name}${SEP}${s.windows.length}${SEP}${s.created}`,
      );
      return ok(lines.map((l) => l + "\n").join(""));
    }
    if (cmd.includes("list-windows")) {
      const s = this.sessions.get(argAfter("-t", cmd) ?? "");
      if (!s) return ok("");
      const lines = s.windows.map(
        (w) => `${w.id}${SEP}${w.index}${SEP}${w.active ? 1 : 0}${SEP}${w.cwd}${SEP}${w.name}`,
      );
      return ok(lines.map((l) => l + "\n").join(""));
    }
    if (cmd.includes("new-window")) {
      const s = this.sessions.get(argAfter("-t", cmd) ?? "");
      if (!s) return ok("");
      // Honor -c (start-directory) so split-inherits-cwd is testable; else the default.
      const win = this.addWindow(s, argAfter("-n", cmd) ?? "bash", argAfter("-c", cmd));
      return ok(`${win.id}\n`);
    }
    if (cmd.includes("new-session")) {
      const name = argAfter("-s", cmd);
      if (name && !this.sessions.has(name)) this.createSession(name);
      return ok();
    }
    if (cmd.includes("rename-session")) {
      const from = argAfter("-t", cmd);
      const to = lastQuoted(cmd);
      const s = from ? this.sessions.get(from) : undefined;
      if (s && from && to && from !== to) {
        this.sessions.delete(from);
        this.sessions.set(to, s);
      }
      return ok();
    }
    if (cmd.includes("rename-window")) {
      const w = this.findWindow(argAfter("-t", cmd) ?? "");
      const to = lastQuoted(cmd);
      if (w && to) w.name = to;
      return ok();
    }
    if (cmd.includes("kill-window")) {
      const id = argAfter("-t", cmd);
      if (id)
        for (const s of this.sessions.values()) s.windows = s.windows.filter((w) => w.id !== id);
      return ok();
    }
    if (cmd.includes("kill-session")) {
      const name = argAfter("-t", cmd);
      if (name) this.sessions.delete(name);
      return ok();
    }
    // has-session / set-option / select-window / anything else: benign success.
    return ok();
  }

  // A real `tmux new-session` creates the session with one window — match that so the
  // desktop has a window to attach.
  private createSession(name: string): FakeSession {
    const s: FakeSession = { id: `$${this.sessSeq++}`, created: Date.now(), windows: [] };
    this.sessions.set(name, s);
    this.addWindow(s, "bash");
    return s;
  }

  private addWindow(s: FakeSession, name: string, cwd = "/home/user"): FakeWindow {
    s.windows.forEach((w) => (w.active = false));
    const win: FakeWindow = {
      id: `@${this.winSeq++}`,
      index: s.windows.length,
      name,
      cwd,
      active: true,
    };
    s.windows.push(win);
    return win;
  }

  private findWindow(id: string): FakeWindow | undefined {
    for (const s of this.sessions.values()) {
      const w = s.windows.find((x) => x.id === id);
      if (w) return w;
    }
    return undefined;
  }

  openViewer(
    _base: string,
    _viewer: string,
    _windowIndex: number,
    _dims: Dims,
  ): Promise<ClientChannel> {
    const stream = new FakePaneStream();
    this.streams.add(stream);
    stream.on("close", () => this.streams.delete(stream));
    // The gateway uses only .on("data"|"close"), .write(), .setWindow(), .stderr?, .end() —
    // all provided. Cast across the unused ClientChannel surface (dev-only).
    return Promise.resolve(stream as unknown as ClientChannel);
  }

  onClose(cb: () => void): void {
    this.closeCbs.add(cb);
  }

  destroy(): void {
    if (this.closed) return;
    this.closed = true;
    for (const s of this.streams) s.end();
    for (const cb of this.closeCbs) {
      try {
        cb();
      } catch {
        /* ignore */
      }
    }
  }
}
