/**
 * MOCK terminal gateway — DEV / UI-TESTING ONLY, OPT-IN.
 *
 * Speaks the exact same WebSocket protocol as the real gateway (server/terminal-gateway.ts)
 * so the frontend renders a fully working terminal UI — tabs, splits, desktops, the mobile
 * layout — WITHOUT ssh2 or tmux. Instead of a real PTY, each pane runs a fake shell that
 * prints a banner and answers every command with a POSIX-style "command not found".
 *
 * Run it INSTEAD of `gateway:dev` when you only need to work on the UI:
 *     npm run dev            # frontend (Vite proxies /ws + /auth to :8081)
 *     npm run gateway:mock   # this file (listens on 127.0.0.1:8081)
 * Log in with ANY username/password.
 *
 * Safety: it refuses to start when NODE_ENV=production, binds to loopback, and lives in a
 * separate file/script so it can never be confused with the real gateway. It reuses the
 * wire contract (protocol.ts) and config (config.ts) so the UI behaves identically; only
 * the auth/WS shell is local (and intentionally trivial — it accepts everyone).
 */
import http from "node:http";
import crypto from "node:crypto";
import { WebSocketServer, WebSocket, type RawData } from "ws";

import { getGatewayConfig, type GatewayConfig } from "./config";
import {
  ClientMsgSchema,
  encodeOutputFrame,
  reconcileLayout,
  type ServerMsg,
  type SessionInfo,
  type WindowInfo,
  type DesktopLayout,
} from "./protocol";

// --------------------------- tiny HTTP/cookie helpers ----------------------------
// Local copies (dev-only). The only client-facing contract is "POST /auth -> 200 + cookie"
// and "WS /ws accepts that cookie"; the cookie name is internal to this mock.
const COOKIE = "gw_sid";

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(json);
}

function readBody(req: http.IncomingMessage, limit = 16 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c: Buffer) => {
      data += c;
      if (data.length > limit) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function cookieString(sid: string, cfg: GatewayConfig): string {
  const parts = [`${COOKIE}=${sid}`, "HttpOnly", "Path=/", "SameSite=Strict", "Max-Age=43200"];
  if (cfg.cookieSecure) parts.push("Secure");
  return parts.join("; ");
}

function clearCookieString(cfg: GatewayConfig): string {
  const parts = [`${COOKIE}=`, "HttpOnly", "Path=/", "SameSite=Strict", "Max-Age=0"];
  if (cfg.cookieSecure) parts.push("Secure");
  return parts.join("; ");
}

function originAllowed(origin: string | undefined, cfg: GatewayConfig): boolean {
  if (cfg.allowedOrigins.length === 0) return !cfg.isProduction; // dev: allow
  return origin != null && cfg.allowedOrigins.includes(origin);
}

// Dev-only CORS: lets a separately-served frontend (e.g. `npm run dev` on :3000, whose
// proxy may not forward /auth) hit the mock cross-origin with credentials. Reflects the
// allowed Origin (required when credentials are included — `*` is rejected by browsers).
function applyCors(req: http.IncomingMessage, res: http.ServerResponse, cfg: GatewayConfig) {
  const origin = req.headers.origin;
  if (origin && originAllowed(origin, cfg)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
  }
}

// --------------------------- the fake shell ----------------------------
const BANNER = "This is not a real shell, for UI testing purposes only.\r\n$ ";
const PROMPT = "$ ";

// --------------------------- per-connection mock ----------------------------
// In-memory only; everything resets when the socket closes. One MockConnection per socket.
// Saved layouts persist per user at module scope so they survive reconnects/reloads (the
// real gateway persists to disk). Sessions/windows are still reseeded per connection, but
// the seeded window id (@0) is deterministic, so persisted per-window data like zoom
// reapplies. This lets the mock exercise layout/zoom persistence in UI testing.
const userLayouts = new Map<string, Map<string, DesktopLayout>>();

class MockConnection {
  private sessions: SessionInfo[] = [];
  private windows = new Map<string, WindowInfo[]>(); // session -> windows
  private layouts: Map<string, DesktopLayout>; // session -> saved layout (per-user, persisted)
  private lines = new Map<string, string>(); // `${session}:${windowId}` -> current input line
  private attached = new Set<string>(); // attached pane keys
  private winSeq = 0;

  constructor(
    private ws: WebSocket,
    private cfg: GatewayConfig,
    user: string,
  ) {
    // Reuse this user's persisted layouts across connections.
    this.layouts = userLayouts.get(user) ?? new Map();
    userLayouts.set(user, this.layouts);

    // Seed one desktop with one window, like an ssh login giving you a shell.
    const name = `${cfg.sessionPrefix}-${user}-1`;
    this.windows.set(name, [this.mkWindow(0, "bash", true)]);
    this.sessions.push({ id: name, name, windows: 1, created: Date.now() });

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (!isBinary) this.onMessage(data.toString("utf8"));
    });
  }

  private mkWindow(index: number, wname: string, active = false): WindowInfo {
    return { id: `@${this.winSeq++}`, index, name: wname, active };
  }

  private send(msg: ServerMsg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private write(session: string, windowId: string, text: string) {
    if (this.ws.readyState === WebSocket.OPEN)
      this.ws.send(encodeOutputFrame(session, windowId, new TextEncoder().encode(text)));
  }

  private pushSessions() {
    this.sessions = this.sessions.map((s) => ({
      ...s,
      windows: this.windows.get(s.name)?.length ?? 0,
    }));
    this.send({ type: "sessions", sessions: this.sessions });
  }

  private onMessage(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const result = ClientMsgSchema.safeParse(parsed);
    if (!result.success) return this.send({ type: "error", scope: "protocol", message: "bad msg" });
    const msg = result.data;

    switch (msg.type) {
      case "ping":
        return this.send({ type: "pong" });
      case "listSessions":
        return this.pushSessions();
      case "listWindows":
        return this.send({
          type: "windows",
          session: msg.session,
          windows: this.windows.get(msg.session) ?? [],
        });
      case "getLayout":
        return this.send({
          type: "layout",
          session: msg.session,
          layout: reconcileLayout(
            this.layouts.get(msg.session),
            this.windows.get(msg.session) ?? [],
          ),
        });
      case "saveLayout":
        this.layouts.set(msg.session, msg.layout);
        return;
      case "attachPane": {
        const key = `${msg.session}:${msg.windowId}`;
        if (this.attached.has(key)) return;
        this.attached.add(key);
        this.lines.set(key, "");
        this.send({ type: "attached", session: msg.session, windowId: msg.windowId });
        this.write(msg.session, msg.windowId, BANNER);
        return;
      }
      case "detachPane": {
        const key = `${msg.session}:${msg.windowId}`;
        this.attached.delete(key);
        this.lines.delete(key);
        return;
      }
      case "input":
        return this.handleInput(msg.session, msg.windowId, msg.data);
      case "resize":
        return; // no real PTY; nothing to resize
      case "newSession": {
        const n = this.sessions.length + 1;
        const name = `${this.cfg.sessionPrefix}-mock-${n}`;
        this.windows.set(name, [this.mkWindow(0, "bash", true)]);
        this.sessions.push({ id: name, name, windows: 1, created: Date.now() });
        return this.pushSessions();
      }
      case "killSession": {
        this.sessions = this.sessions.filter((s) => s.name !== msg.session);
        this.windows.delete(msg.session);
        this.layouts.delete(msg.session);
        return this.pushSessions();
      }
      case "newWindow": {
        const list = this.windows.get(msg.session);
        if (!list) return;
        const win = this.mkWindow(list.length, msg.name || `win${list.length}`);
        list.push(win);
        // Echo the id BEFORE the windows snapshot so a split can place it (matches the real
        // gateway ordering — otherwise reconcile appends it as its own tab).
        this.send({
          type: "windowCreated",
          session: msg.session,
          windowId: win.id,
          requestId: msg.requestId,
        });
        this.send({ type: "windows", session: msg.session, windows: list });
        return this.pushSessions();
      }
      case "killWindow": {
        const list = this.windows.get(msg.session);
        if (!list) return;
        this.windows.set(
          msg.session,
          list.filter((w) => w.id !== msg.windowId),
        );
        const key = `${msg.session}:${msg.windowId}`;
        if (this.attached.delete(key))
          this.send({ type: "paneExit", session: msg.session, windowId: msg.windowId });
        this.send({
          type: "windows",
          session: msg.session,
          windows: this.windows.get(msg.session) ?? [],
        });
        return this.pushSessions();
      }
      case "renameSession": {
        // best-effort rename of the session name across our maps
        return this.pushSessions();
      }
      case "renameWindow": {
        const list = this.windows.get(msg.session);
        if (!list) return;
        const w = list.find((x) => x.id === msg.windowId);
        if (w) w.name = msg.name;
        return this.send({ type: "windows", session: msg.session, windows: list });
      }
    }
  }

  // Fake line-buffered shell. xterm sends raw keystrokes with no local echo (a real PTY
  // echoes), so we echo here. Escape sequences (arrows etc.) are ignored.
  private handleInput(session: string, windowId: string, data: string) {
    const key = `${session}:${windowId}`;
    if (!this.attached.has(key)) return;
    let line = this.lines.get(key) ?? "";
    for (const ch of data) {
      if (ch === "\r" || ch === "\n") {
        const cmd = line.trim();
        this.write(session, windowId, "\r\n");
        if (cmd) this.write(session, windowId, `${cmd.split(/\s+/)[0]}: command not found\r\n`);
        this.write(session, windowId, PROMPT);
        line = "";
      } else if (ch === "\x7f") {
        if (line.length > 0) {
          line = line.slice(0, -1);
          this.write(session, windowId, "\b \b");
        }
      } else if (ch === "\x03") {
        this.write(session, windowId, "^C\r\n" + PROMPT);
        line = "";
      } else if (ch >= " ") {
        line += ch;
        this.write(session, windowId, ch);
      }
      // else: ignore other control chars / escape sequences
    }
    this.lines.set(key, line);
  }
}

// --------------------------- server bootstrap ----------------------------
function main() {
  const cfg = getGatewayConfig();
  if (cfg.isProduction) {
    console.error("mock-gateway refuses to run with NODE_ENV=production. Use the real gateway.");
    process.exit(1);
  }

  const sessions = new Set<string>(); // valid gw_sid values
  const wss = new WebSocketServer({ noServer: true });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Dev CORS preflight for the auth endpoints.
    if (req.method === "OPTIONS" && url.pathname.startsWith("/auth")) {
      applyCors(req, res, cfg);
      res.writeHead(204);
      return void res.end();
    }
    if (req.method === "POST" && url.pathname === "/auth") {
      if (!originAllowed(req.headers.origin, cfg))
        return sendJson(res, 403, { error: "forbidden origin" });
      applyCors(req, res, cfg);
      return void readBody(req).then((body) => {
        let username = "";
        try {
          const parsed = JSON.parse(body) as { username?: unknown; password?: unknown };
          username = typeof parsed.username === "string" ? parsed.username : "";
          const password = typeof parsed.password === "string" ? parsed.password : "";
          if (!username || !password) return sendJson(res, 400, { error: "missing credentials" });
        } catch {
          return sendJson(res, 400, { error: "bad request" });
        }
        const sid = `${crypto.randomBytes(12).toString("hex")}:${username}`;
        sessions.add(sid);
        res.setHeader("Set-Cookie", cookieString(sid, cfg));
        sendJson(res, 200, { ok: true, user: username });
      });
    }
    if (req.method === "POST" && url.pathname === "/auth/logout") {
      applyCors(req, res, cfg);
      const sid = parseCookies(req.headers.cookie)[COOKIE];
      if (sid) sessions.delete(sid);
      res.setHeader("Set-Cookie", clearCookieString(cfg));
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === "GET" && url.pathname === "/healthz")
      return sendJson(res, 200, { ok: true });
    sendJson(res, 404, { error: "not found" });
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname !== "/ws") return void socket.destroy();
    if (!originAllowed(req.headers.origin, cfg)) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      return void socket.destroy();
    }
    const sid = parseCookies(req.headers.cookie)[COOKIE];
    if (!sid || !sessions.has(sid)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      return void socket.destroy();
    }
    const user = sid.split(":")[1] || "mock";
    wss.handleUpgrade(req, socket, head, (ws) => {
      new MockConnection(ws, cfg, user);
    });
  });

  server.listen(cfg.gatewayPort, cfg.gatewayBind, () => {
    console.log(
      `MOCK gateway (fake shell, UI testing only) listening on ${cfg.gatewayBind}:${cfg.gatewayPort} — log in with any username/password`,
    );
  });
}

main();
