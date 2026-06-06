import process from "node:process";
import os from "node:os";
import path from "node:path";

// Gateway configuration. Read env INSIDE the function (never at module scope) so values
// bind at process start / per call rather than being frozen at import time.

export interface GatewayConfig {
  gatewayPort: number;
  gatewayBind: string;
  sshHost: string;
  sshPort: number;
  /** Path to a known_hosts file for host-key pinning. Required in production. */
  knownHostsPath: string | undefined;
  /** Allowed Origin values for WS upgrades + /auth (anti-CSWSH). Empty = allow in dev only. */
  allowedOrigins: string[];
  idleTimeoutMs: number;
  sessionTtlMs: number;
  listPollMs: number;
  maxDesktopsPerUser: number;
  /** Max concurrently-attached panes (each = one ssh channel; sshd MaxSessions default 10). */
  maxPanesPerUser: number;
  authRateMax: number;
  authRateWindowMs: number;
  /** Directory for per-user layout sidecar JSON files. */
  layoutDir: string;
  /** tmux session name prefix; full name is `<prefix>-<user>-<n>`. */
  sessionPrefix: string;
  isProduction: boolean;
  cookieSecure: boolean;
  /** DEV ONLY: fake the ssh2/host connection (tmux+shell) so the UI runs without a real
   * SSH host. Forced off in production regardless of env. See fake-host-connection.ts. */
  mockSsh: boolean;
}

function num(v: string | undefined, dflt: number): number {
  const n = v == null || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : dflt;
}

function defaultLayoutDir(): string {
  return path.join(os.homedir(), ".web-terminal", "layouts");
}

export function getGatewayConfig(): GatewayConfig {
  const isProduction = process.env.NODE_ENV === "production";
  const allowedOrigins = (process.env.ALLOWED_ORIGIN ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    gatewayPort: num(process.env.GATEWAY_PORT, 8081),
    gatewayBind: process.env.GATEWAY_BIND ?? "127.0.0.1",
    sshHost: process.env.SSH_HOST ?? "127.0.0.1",
    sshPort: num(process.env.SSH_PORT, 22),
    knownHostsPath: process.env.SSH_KNOWN_HOSTS || undefined,
    allowedOrigins,
    idleTimeoutMs: num(process.env.IDLE_TIMEOUT_MS, 30 * 60_000),
    sessionTtlMs: num(process.env.SESSION_TTL_MS, 12 * 60 * 60_000),
    listPollMs: num(process.env.LIST_POLL_MS, 2000),
    maxDesktopsPerUser: num(process.env.MAX_DESKTOPS_PER_USER, 8),
    maxPanesPerUser: num(process.env.MAX_PANES_PER_USER, 8),
    authRateMax: num(process.env.AUTH_RATE_MAX, 5),
    authRateWindowMs: num(process.env.AUTH_RATE_WINDOW_MS, 15 * 60_000),
    layoutDir: process.env.LAYOUT_DIR || defaultLayoutDir(),
    sessionPrefix: process.env.SESSION_PREFIX || "web",
    isProduction,
    cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === "true" : isProduction,
    // Never allow the fake host in production, even if MOCK_SSH leaks into the env.
    mockSsh: !isProduction && process.env.MOCK_SSH === "1",
  };
}
