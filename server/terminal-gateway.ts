import http from "node:http";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";

import { WebSocketServer, WebSocket, type RawData } from "ws";
import type { ClientChannel, ConnectConfig } from "ssh2";

import { getGatewayConfig, type GatewayConfig } from "./config";
import { Registry, RateLimiter } from "./registry";
import { LayoutStore } from "./layout-store";
import { UserConnection, classifyConnectError, type HostConnection } from "./ssh-connection";
import {
  ClientMsgSchema,
  type ClientMsg,
  type ServerMsg,
  type ServerErrorScope,
  type WindowInfo,
  encodeOutputFrame,
  isValidName,
  reconcileLayout,
} from "./protocol";
import {
  tmux,
  ownsSession,
  isViewerSession,
  nextSessionName,
  parseSessions,
  parseWindows,
  VIEWER_PREFIX,
} from "./tmux";
import { log } from "./log";

// ----------------------------- helpers -----------------------------

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookieString(sid: string, cfg: GatewayConfig): string {
  const parts = [`gw_sid=${sid}`, "HttpOnly", "Path=/", "SameSite=Strict", "Max-Age=43200"];
  if (cfg.cookieSecure) parts.push("Secure");
  return parts.join("; ");
}

function clearCookieString(cfg: GatewayConfig): string {
  const parts = ["gw_sid=", "HttpOnly", "Path=/", "SameSite=Strict", "Max-Age=0"];
  if (cfg.cookieSecure) parts.push("Secure");
  return parts.join("; ");
}

function originAllowed(origin: string | undefined, cfg: GatewayConfig): boolean {
  if (cfg.allowedOrigins.length === 0) return !cfg.isProduction; // dev: allow; prod: must configure
  return origin != null && cfg.allowedOrigins.includes(origin);
}

// DEV/MOCK ONLY: when the fake host is active, allow the dev frontend (served on another
// port, e.g. :3000) to hit /auth cross-origin with credentials — the Vite dev proxy does
// not forward /auth. Gated by cfg.mockSsh (false in production), so the real auth path is
// untouched. Reflects the allowed Origin (required with credentials; `*` is rejected).
function applyMockCors(req: http.IncomingMessage, res: http.ServerResponse, cfg: GatewayConfig) {
  if (!cfg.mockSsh) return;
  const origin = req.headers.origin;
  if (origin && originAllowed(origin, cfg)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

function readBody(req: http.IncomingMessage, limit = 16 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// Build an ssh2 hostVerifier from a known_hosts file (pinning). Fail closed in prod.
function buildHostVerifier(cfg: GatewayConfig): ConnectConfig["hostVerifier"] {
  if (!cfg.knownHostsPath) {
    if (cfg.isProduction)
      throw new Error("SSH_KNOWN_HOSTS is required in production (host-key pinning)");
    log.warn("SSH_KNOWN_HOSTS not set — accepting ANY host key. DEV ONLY.");
    return () => true;
  }
  const keys = loadKnownHostKeys(cfg.knownHostsPath, cfg.sshHost, cfg.sshPort);
  if (keys.length === 0) {
    log.warn("No matching known_hosts entry for host; all connections will be rejected", {
      host: cfg.sshHost,
      port: cfg.sshPort,
    });
  }
  return (key: Buffer) => keys.some((k) => k.equals(key));
}

function loadKnownHostKeys(path: string, host: string, port: number): Buffer[] {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (err) {
    log.warn("could not read known_hosts", { path, err: String(err) });
    return [];
  }
  const targets = new Set([host, `[${host}]:${port}`]);
  const out: Buffer[] = [];
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/\s+/);
    // [marker] hosts keytype base64 [comment]
    const offset = parts[0]?.startsWith("@") ? 1 : 0;
    const hosts = parts[offset];
    const base64 = parts[offset + 2];
    if (!hosts || !base64) continue;
    if (hosts.startsWith("|")) continue; // hashed host entry — cannot match without salt; skip
    const matches = hosts.split(",").some((h) => targets.has(h));
    if (!matches) continue;
    try {
      out.push(Buffer.from(base64, "base64"));
    } catch {
      /* ignore malformed */
    }
  }
  return out;
}

// ----------------------------- per-connection session -----------------------------

interface Pane {
  stream: ClientChannel;
  viewer: string;
  session: string;
  windowId: string;
}

class GatewayConnection {
  private panes = new Map<string, Pane>();
  private polls = new Map<string, { timer: ReturnType<typeof setInterval>; last: string }>();
  private readonly user: string;
  private readonly prefix: string;

  constructor(
    private ws: WebSocket,
    private conn: HostConnection,
    private cfg: GatewayConfig,
    private layout: LayoutStore,
    private touch: () => void,
  ) {
    this.user = conn.username;
    this.prefix = cfg.sessionPrefix;
    ws.binaryType = "nodebuffer";
    ws.on("message", (data, isBinary) => void this.onMessage(data, isBinary));
    ws.on("close", () => this.cleanup());
    ws.on("error", () => this.cleanup());
    void this.pushSessions();
  }

  private send(msg: ServerMsg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  private sendBinary(frame: Uint8Array) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(frame);
  }

  private err(scope: ServerErrorScope, message: string) {
    this.send({ type: "error", scope, message });
  }

  private owns(session: string): boolean {
    return ownsSession(session, this.user, this.prefix);
  }

  private async onMessage(data: RawData, isBinary: boolean) {
    this.touch();
    if (isBinary) return; // client sends only JSON control frames
    let msg: ClientMsg;
    try {
      const parsed = ClientMsgSchema.safeParse(JSON.parse(data.toString("utf8")));
      if (!parsed.success) return this.err("protocol", "invalid message");
      msg = parsed.data;
    } catch {
      return this.err("protocol", "invalid json");
    }
    try {
      await this.dispatch(msg);
    } catch (e) {
      log.warn("dispatch failed", { type: msg.type, err: String(e) });
      this.err("tmux", "operation failed");
    }
  }

  private async dispatch(msg: ClientMsg) {
    switch (msg.type) {
      case "ping":
        return this.send({ type: "pong" });
      case "listSessions":
        return this.pushSessions();
      case "listWindows":
        if (this.owns(msg.session)) return this.pushWindows(msg.session);
        return;
      case "attachPane":
        return this.attachPane(msg);
      case "detachPane":
        return this.detachPane(msg.session, msg.windowId);
      case "input": {
        const pane = this.panes.get(key(msg.session, msg.windowId));
        if (pane) pane.stream.write(msg.data);
        return;
      }
      case "resize": {
        const pane = this.panes.get(key(msg.session, msg.windowId));
        if (pane) pane.stream.setWindow(msg.rows, msg.cols, 0, 0); // rows first (ssh2)
        return;
      }
      case "newSession":
        return this.newSession();
      case "killSession":
        return this.killSession(msg.session);
      case "renameSession":
        if (this.owns(msg.session) && isValidName(msg.name)) {
          await this.conn.exec(tmux.renameSession(msg.session, msg.name));
          await this.pushSessions();
        }
        return;
      case "newWindow":
        if (this.owns(msg.session) && (!msg.name || isValidName(msg.name))) {
          const res = await this.conn.exec(tmux.newWindow(msg.session, msg.name));
          const windowId = res.stdout.trim().split("\n")[0] ?? "";
          // Echo the new id BEFORE the windows snapshot so a split can place it
          // (otherwise reconcile would append it as its own tab).
          if (windowId)
            this.send({
              type: "windowCreated",
              session: msg.session,
              windowId,
              requestId: msg.requestId,
            });
          await this.pushWindows(msg.session);
          await this.pushSessions();
        }
        return;
      case "killWindow":
        return this.killWindow(msg.session, msg.windowId);
      case "renameWindow":
        return this.renameWindow(msg.session, msg.windowId, msg.name);
      case "getLayout":
        return this.sendLayout(msg.session);
      case "saveLayout":
        if (this.owns(msg.session))
          await this.layout.setDesktop(this.user, msg.session, msg.layout);
        return;
    }
  }

  private async getWindows(session: string): Promise<WindowInfo[]> {
    const out = await this.conn.exec(tmux.listWindows(session));
    return parseWindows(out.stdout);
  }

  private async pushSessions() {
    const out = await this.conn.exec(tmux.listSessions());
    let sessions = parseSessions(out.stdout).filter(
      (s) => this.owns(s.name) && !isViewerSession(s.name),
    );
    if (sessions.length === 0) {
      // First login: give the user a desktop, like `ssh in -> a shell`.
      const name = nextSessionName([], this.user, this.prefix);
      await this.conn.exec(tmux.newSession(name));
      const out2 = await this.conn.exec(tmux.listSessions());
      sessions = parseSessions(out2.stdout).filter(
        (s) => this.owns(s.name) && !isViewerSession(s.name),
      );
    }
    this.send({ type: "sessions", sessions });
  }

  private async pushWindows(session: string) {
    if (!this.owns(session)) return;
    const windows = await this.getWindows(session);
    this.send({ type: "windows", session, windows });
  }

  private async sendLayout(session: string) {
    if (!this.owns(session)) return;
    const saved = await this.layout.getDesktop(this.user, session);
    const windows = await this.getWindows(session);
    this.send({ type: "layout", session, layout: reconcileLayout(saved, windows) });
  }

  private async attachPane(msg: Extract<ClientMsg, { type: "attachPane" }>) {
    if (!this.owns(msg.session) || !isValidName(msg.windowId))
      return this.err("protocol", "bad target");
    const k = key(msg.session, msg.windowId);
    if (this.panes.has(k)) return;
    if (this.panes.size >= this.cfg.maxPanesPerUser)
      return this.err("limit", "too many open panes");

    const windows = await this.getWindows(msg.session);
    const win = windows.find((w) => w.id === msg.windowId);
    if (!win) return this.err("tmux", "window not found");

    const viewer = VIEWER_PREFIX + crypto.randomBytes(6).toString("hex");
    let stream: ClientChannel;
    try {
      stream = await this.conn.openViewer(msg.session, viewer, win.index, {
        cols: msg.cols,
        rows: msg.rows,
      });
    } catch (e) {
      return this.err("tmux", `attach failed: ${String(e)}`);
    }
    this.panes.set(k, { stream, viewer, session: msg.session, windowId: msg.windowId });
    stream.on("data", (d: Buffer) =>
      this.sendBinary(encodeOutputFrame(msg.session, msg.windowId, new Uint8Array(d))),
    );
    stream.stderr?.on("data", () => {});
    stream.on("close", () => {
      this.panes.delete(k);
      this.killViewer(viewer); // viewer no longer self-destructs — clean it up on close
      this.send({ type: "paneExit", session: msg.session, windowId: msg.windowId });
      this.stopPollIfIdle(msg.session);
    });
    this.send({ type: "attached", session: msg.session, windowId: msg.windowId });
    this.startPoll(msg.session);
  }

  private detachPane(session: string, windowId: string) {
    const k = key(session, windowId);
    const pane = this.panes.get(k);
    if (!pane) return;
    this.panes.delete(k);
    try {
      pane.stream.end();
    } catch {
      /* ignore */
    }
    this.killViewer(pane.viewer);
    this.stopPollIfIdle(session);
  }

  private async killSession(session: string) {
    if (!this.owns(session)) return this.err("protocol", "not your session");
    for (const [k, p] of this.panes) {
      if (p.session === session) {
        this.panes.delete(k);
        try {
          p.stream.end();
        } catch {
          /* ignore */
        }
        this.killViewer(p.viewer);
      }
    }
    await this.conn.exec(tmux.killSession(session));
    await this.layout.removeDesktop(this.user, session);
    this.stopPollIfIdle(session);
    await this.pushSessions();
  }

  private async killWindow(session: string, windowId: string) {
    if (!this.owns(session)) return this.err("protocol", "not your session");
    const windows = await this.getWindows(session);
    if (!windows.some((w) => w.id === windowId)) return this.err("tmux", "unknown window");
    this.detachPane(session, windowId);
    await this.conn.exec(tmux.killWindow(windowId));
    await this.pushWindows(session);
    await this.pushSessions();
  }

  private async renameWindow(session: string, windowId: string, name: string) {
    if (!this.owns(session) || !isValidName(name)) return this.err("protocol", "bad target");
    const windows = await this.getWindows(session);
    if (!windows.some((w) => w.id === windowId)) return this.err("tmux", "unknown window");
    await this.conn.exec(tmux.renameWindow(windowId, name));
    await this.pushWindows(session);
  }

  private async newSession() {
    const out = await this.conn.exec(tmux.listSessions());
    const owned = parseSessions(out.stdout).filter(
      (s) => this.owns(s.name) && !isViewerSession(s.name),
    );
    if (owned.length >= this.cfg.maxDesktopsPerUser) return this.err("limit", "too many desktops");
    const name = nextSessionName(
      owned.map((s) => s.name),
      this.user,
      this.prefix,
    );
    await this.conn.exec(tmux.newSession(name));
    await this.pushSessions();
  }

  private killViewer(viewer: string) {
    void this.conn.exec(tmux.killSessionQuiet(viewer)).catch(() => {});
  }

  private startPoll(session: string) {
    if (this.polls.has(session)) return;
    const timer = setInterval(async () => {
      const entry = this.polls.get(session);
      if (!entry) return;
      try {
        const windows = await this.getWindows(session);
        const ser = JSON.stringify(windows);
        if (ser !== entry.last) {
          entry.last = ser;
          this.send({ type: "windows", session, windows });
        }
      } catch {
        /* transient; try again next tick */
      }
    }, this.cfg.listPollMs);
    this.polls.set(session, { timer, last: "" });
  }

  private stopPollIfIdle(session: string) {
    const stillUsed = [...this.panes.values()].some((p) => p.session === session);
    if (stillUsed) return;
    const entry = this.polls.get(session);
    if (entry) {
      clearInterval(entry.timer);
      this.polls.delete(session);
    }
  }

  private cleanup() {
    for (const p of this.panes.values()) {
      try {
        p.stream.end();
      } catch {
        /* ignore */
      }
      this.killViewer(p.viewer);
    }
    this.panes.clear();
    for (const e of this.polls.values()) clearInterval(e.timer);
    this.polls.clear();
  }
}

function key(session: string, windowId: string): string {
  return `${session}:${windowId}`;
}

// ----------------------------- bootstrap -----------------------------

function main() {
  const cfg = getGatewayConfig();
  const hostVerifier = buildHostVerifier(cfg); // throws in prod if no known_hosts
  const registry = new Registry(cfg);
  const rateLimiter = new RateLimiter(cfg.authRateMax, cfg.authRateWindowMs);
  const layoutStore = new LayoutStore(cfg.layoutDir);
  const wss = new WebSocketServer({ noServer: true });

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    // Dev/mock CORS preflight for cross-origin /auth (no-op unless cfg.mockSsh).
    if (cfg.mockSsh && req.method === "OPTIONS" && url.pathname.startsWith("/auth")) {
      applyMockCors(req, res, cfg);
      res.writeHead(204);
      return void res.end();
    }
    if (req.method === "POST" && url.pathname === "/auth") return void handleAuth(req, res);
    if (req.method === "POST" && url.pathname === "/auth/logout")
      return void handleLogout(req, res);
    if (req.method === "GET" && url.pathname === "/healthz")
      return sendJson(res, 200, { ok: true });
    sendJson(res, 404, { error: "not found" });
  });

  async function handleAuth(req: http.IncomingMessage, res: http.ServerResponse) {
    applyMockCors(req, res, cfg); // dev/mock only; no-op otherwise
    if (!originAllowed(req.headers.origin, cfg))
      return sendJson(res, 403, { error: "forbidden origin" });
    let username = "";
    let password = "";
    try {
      const body = JSON.parse(await readBody(req)) as { username?: unknown; password?: unknown };
      username = typeof body.username === "string" ? body.username : "";
      password = typeof body.password === "string" ? body.password : "";
    } catch {
      return sendJson(res, 400, { error: "bad request" });
    }
    if (!username || !password) return sendJson(res, 400, { error: "missing credentials" });

    const ip = req.socket.remoteAddress ?? "?";
    if (!rateLimiter.allow(`${ip}|${username}`))
      return sendJson(res, 429, { error: "too many attempts" });

    try {
      // Dev: fake the host (no ssh2/tmux). Dynamically imported so it never loads in prod.
      const conn: HostConnection = cfg.mockSsh
        ? await (await import("./fake-host-connection")).FakeHostConnection.connect(username)
        : await UserConnection.connect(username, password, cfg, hostVerifier);
      const sid = registry.add(conn);
      res.setHeader("Set-Cookie", cookieString(sid, cfg));
      log.info("auth ok", { user: username });
      sendJson(res, 200, { ok: true, user: username });
    } catch (err) {
      // Report the real cause (never the password): a reboot that breaks container->host
      // networking otherwise looks identical to a wrong password. `reason` is host-level
      // (reachable? key trusted?), not a per-username oracle, so surfacing it is safe.
      const { reason, detail } = classifyConnectError(err);
      log.warn("auth failed", { user: username, ip, reason, detail });
      if (reason === "host-unreachable")
        return sendJson(res, 502, { error: "host unreachable", reason });
      sendJson(res, 401, { error: "authentication failed", reason });
    }
  }

  function handleLogout(req: http.IncomingMessage, res: http.ServerResponse) {
    const sid = parseCookies(req.headers.cookie).gw_sid;
    if (sid) registry.remove(sid);
    res.setHeader("Set-Cookie", clearCookieString(cfg));
    sendJson(res, 200, { ok: true });
  }

  server.on("upgrade", (req, socket, head) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname !== "/ws") return void socket.destroy();
      if (!originAllowed(req.headers.origin, cfg)) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        return void socket.destroy();
      }
      const sid = parseCookies(req.headers.cookie).gw_sid;
      const conn = sid ? registry.get(sid) : undefined;
      if (!conn || !sid) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        return void socket.destroy();
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        new GatewayConnection(ws, conn, cfg, layoutStore, () => registry.touch(sid));
      });
    } catch {
      socket.destroy();
    }
  });

  if (cfg.mockSsh)
    log.warn("MOCK_SSH active — faking the ssh2/host connection (dev UI testing only)", {});

  server.listen(cfg.gatewayPort, cfg.gatewayBind, () => {
    log.info("terminal gateway listening", {
      bind: cfg.gatewayBind,
      port: cfg.gatewayPort,
      sshHost: cfg.sshHost,
      sshPort: cfg.sshPort,
      production: cfg.isProduction,
    });
  });
}

main();
