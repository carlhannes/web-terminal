import crypto from "node:crypto";

import type { GatewayConfig } from "./config";
import type { UserConnection } from "./ssh-connection";
import { log } from "./log";

interface Entry {
  conn: UserConnection;
  user: string;
  createdAt: number;
  idleTimer: ReturnType<typeof setTimeout>;
  ttlTimer: ReturnType<typeof setTimeout>;
}

// Maps an opaque cookie session id -> live UserConnection. The password is never
// stored here (or anywhere) — only the authenticated ssh2 connection. Idle and
// absolute-TTL timers reap connections; tmux sessions persist on the host, so the
// user simply re-logs in.
export class Registry {
  private bySid = new Map<string, Entry>();

  constructor(private cfg: GatewayConfig) {}

  add(conn: UserConnection): string {
    const sid = crypto.randomBytes(32).toString("hex");
    const entry: Entry = {
      conn,
      user: conn.username,
      createdAt: Date.now(),
      idleTimer: this.armIdle(sid),
      ttlTimer: setTimeout(() => {
        log.info("session ttl expired", { user: conn.username });
        this.remove(sid);
      }, this.cfg.sessionTtlMs),
    };
    conn.onClose(() => this.remove(sid));
    this.bySid.set(sid, entry);
    return sid;
  }

  get(sid: string): UserConnection | undefined {
    const entry = this.bySid.get(sid);
    if (!entry) return undefined;
    this.touch(sid);
    return entry.conn;
  }

  touch(sid: string): void {
    const entry = this.bySid.get(sid);
    if (!entry) return;
    clearTimeout(entry.idleTimer);
    entry.idleTimer = this.armIdle(sid);
  }

  remove(sid: string): void {
    const entry = this.bySid.get(sid);
    if (!entry) return;
    this.bySid.delete(sid);
    clearTimeout(entry.idleTimer);
    clearTimeout(entry.ttlTimer);
    entry.conn.destroy();
  }

  private armIdle(sid: string): ReturnType<typeof setTimeout> {
    return setTimeout(() => {
      log.info("session idle timeout", { sid: "[redacted]" });
      this.remove(sid);
    }, this.cfg.idleTimeoutMs);
  }
}

// Fixed-window rate limiter for /auth, keyed by `${ip}|${username}`.
export class RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private max: number,
    private windowMs: number,
  ) {}

  /** Returns true if the attempt is allowed (and records it). */
  allow(key: string, now = Date.now()): boolean {
    const e = this.hits.get(key);
    if (!e || now >= e.resetAt) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      return true;
    }
    if (e.count >= this.max) return false;
    e.count += 1;
    return true;
  }
}
