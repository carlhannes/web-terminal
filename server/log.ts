// Tiny logger that redacts sensitive keys. The gateway handles SSH passwords and
// auth cookies — those must NEVER reach logs. Pass structured meta, not interpolated
// strings, so redaction can do its job.

const REDACT_KEYS = new Set(["password", "pass", "gw_sid", "cookie", "authorization", "token"]);

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value == null) return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = REDACT_KEYS.has(k.toLowerCase()) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

type Level = "info" | "warn" | "error";

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const line = `${ts} [${level}] ${msg}`;
  const payload = meta ? redact(meta) : undefined;
  const sink = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  if (payload === undefined) sink(line);
  else sink(line, JSON.stringify(payload));
}

export const log = {
  info: (msg: string, meta?: Record<string, unknown>) => emit("info", msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit("warn", msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit("error", msg, meta),
};
