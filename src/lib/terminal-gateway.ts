import {
  type ClientMsg,
  type ServerMsg,
  type SessionInfo,
  type WindowInfo,
  type DesktopLayout,
  decodeOutputFrame,
} from "../../server/protocol";

// Single client-side owner of the gateway WebSocket (DRY). High-frequency terminal
// OUTPUT is delivered straight to xterm via per-pane subscriptions and NEVER goes
// through React state; only structural snapshots (sessions/windows/layout) and
// connection status do.

export type GatewayStatus = "connecting" | "open" | "reconnecting" | "closed" | "auth-error";

type OutputCb = (bytes: Uint8Array) => void;

function env(key: string): string | undefined {
  return (import.meta.env as Record<string, string | undefined>)[key];
}

/** Same-origin /ws by default (Vite proxy in dev, reverse proxy in prod); override via env. */
export function gatewayWsUrl(): string {
  const override = env("VITE_TERMINAL_GATEWAY_WS_URL");
  if (override) return override;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/ws`;
}

/** Base URL for the auth HTTP endpoints (same-origin by default). */
export function gatewayHttpBase(): string {
  return env("VITE_TERMINAL_GATEWAY_HTTP_URL") ?? "";
}

const MAX_BUFFER_FRAMES = 500;

export class TerminalGatewayClient {
  private ws: WebSocket | undefined;
  private stopped = false;
  private everOpened = false;
  private failedConnects = 0;
  private reconnectDelay = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  private status: GatewayStatus = "closed";
  private statusSubs = new Set<(s: GatewayStatus) => void>();
  private sessionsSubs = new Set<(s: SessionInfo[]) => void>();
  private windowsSubs = new Set<(session: string, windows: WindowInfo[]) => void>();
  private layoutSubs = new Set<(session: string, layout: DesktopLayout) => void>();
  private windowCreatedSubs = new Set<
    (session: string, windowId: string, requestId?: string) => void
  >();
  private outputSubs = new Map<string, Set<OutputCb>>();
  private outputBuffer = new Map<string, Uint8Array[]>();

  private lastSessions: SessionInfo[] = [];

  constructor(private url: string = gatewayWsUrl()) {}

  // ---- lifecycle (reconnectable; safe under React StrictMode remount) ----

  connect(): void {
    this.stopped = false;
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    )
      return;
    this.setStatus(this.everOpened ? "reconnecting" : "connecting");
    const ws = new WebSocket(this.url);
    ws.binaryType = "arraybuffer";
    this.ws = ws;
    ws.onopen = () => {
      this.everOpened = true;
      this.failedConnects = 0;
      this.reconnectDelay = 500;
      this.setStatus("open");
      this.send({ type: "listSessions" });
    };
    ws.onmessage = (ev) => this.onMessage(ev);
    ws.onclose = () => this.onClose();
    ws.onerror = () => {
      /* close handler does the work */
    };
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.ws?.close();
    this.ws = undefined;
  }

  /** Permanent teardown (also drops subscriptions). */
  dispose(): void {
    this.disconnect();
    this.statusSubs.clear();
    this.sessionsSubs.clear();
    this.windowsSubs.clear();
    this.layoutSubs.clear();
    this.outputSubs.clear();
    this.outputBuffer.clear();
  }

  private onClose(): void {
    this.ws = undefined;
    if (this.stopped) {
      this.setStatus("closed");
      return;
    }
    // Closing before ever opening repeatedly almost always means the auth cookie
    // is missing/expired (gateway rejects the upgrade with 401) — stop and prompt login.
    if (!this.everOpened && ++this.failedConnects >= 3) {
      this.setStatus("auth-error");
      return;
    }
    this.setStatus("reconnecting");
    this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 10_000);
  }

  // ---- inbound ----

  private onMessage(ev: MessageEvent): void {
    if (typeof ev.data === "string") {
      let msg: ServerMsg;
      try {
        msg = JSON.parse(ev.data) as ServerMsg;
      } catch {
        return;
      }
      switch (msg.type) {
        case "sessions":
          this.lastSessions = msg.sessions;
          this.sessionsSubs.forEach((cb) => cb(msg.sessions));
          break;
        case "windows":
          this.windowsSubs.forEach((cb) => cb(msg.session, msg.windows));
          break;
        case "layout":
          if (msg.layout)
            this.layoutSubs.forEach((cb) => cb(msg.session, msg.layout as DesktopLayout));
          break;
        case "windowCreated":
          this.windowCreatedSubs.forEach((cb) => cb(msg.session, msg.windowId, msg.requestId));
          break;
        case "error":
          console.warn(`[gateway:${msg.scope}] ${msg.message}`);
          break;
        case "attached":
        case "paneExit":
        case "pong":
          break;
      }
      return;
    }
    // binary OUTPUT frame
    const frame = decodeOutputFrame(new Uint8Array(ev.data as ArrayBuffer));
    if (!frame) return;
    const key = `${frame.session}:${frame.windowId}`;
    const subs = this.outputSubs.get(key);
    if (subs && subs.size) {
      subs.forEach((cb) => cb(frame.payload));
    } else {
      const buf = this.outputBuffer.get(key) ?? [];
      buf.push(frame.payload);
      if (buf.length > MAX_BUFFER_FRAMES) buf.splice(0, buf.length - MAX_BUFFER_FRAMES);
      this.outputBuffer.set(key, buf);
    }
  }

  // ---- subscriptions ----

  onStatus(cb: (s: GatewayStatus) => void): () => void {
    this.statusSubs.add(cb);
    cb(this.status);
    return () => this.statusSubs.delete(cb);
  }

  onSessions(cb: (s: SessionInfo[]) => void): () => void {
    this.sessionsSubs.add(cb);
    if (this.lastSessions.length) cb(this.lastSessions);
    return () => this.sessionsSubs.delete(cb);
  }

  onWindows(cb: (session: string, windows: WindowInfo[]) => void): () => void {
    this.windowsSubs.add(cb);
    return () => this.windowsSubs.delete(cb);
  }

  onLayout(cb: (session: string, layout: DesktopLayout) => void): () => void {
    this.layoutSubs.add(cb);
    return () => this.layoutSubs.delete(cb);
  }

  onWindowCreated(cb: (session: string, windowId: string, requestId?: string) => void): () => void {
    this.windowCreatedSubs.add(cb);
    return () => this.windowCreatedSubs.delete(cb);
  }

  /** Subscribe a pane's xterm to its output stream. Flushes any buffered bytes. */
  subscribeOutput(session: string, windowId: string, cb: OutputCb): () => void {
    const key = `${session}:${windowId}`;
    let subs = this.outputSubs.get(key);
    if (!subs) {
      subs = new Set();
      this.outputSubs.set(key, subs);
    }
    subs.add(cb);
    const buffered = this.outputBuffer.get(key);
    if (buffered) {
      this.outputBuffer.delete(key);
      buffered.forEach((b) => cb(b));
    }
    return () => {
      const set = this.outputSubs.get(key);
      set?.delete(cb);
      if (set && set.size === 0) this.outputSubs.delete(key);
    };
  }

  // ---- outbound ----

  private send(msg: ClientMsg): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  attachPane(session: string, windowId: string, cols: number, rows: number): void {
    this.send({ type: "attachPane", session, windowId, cols, rows });
  }
  detachPane(session: string, windowId: string): void {
    this.send({ type: "detachPane", session, windowId });
  }
  sendInput(session: string, windowId: string, data: string): void {
    this.send({ type: "input", session, windowId, data });
  }
  sendResize(session: string, windowId: string, cols: number, rows: number): void {
    this.send({ type: "resize", session, windowId, cols, rows });
  }
  listWindows(session: string): void {
    this.send({ type: "listWindows", session });
  }
  getLayout(session: string): void {
    this.send({ type: "getLayout", session });
  }
  saveLayout(session: string, layout: DesktopLayout): void {
    this.send({ type: "saveLayout", session, layout });
  }
  newSession(): void {
    this.send({ type: "newSession" });
  }
  killSession(session: string): void {
    this.send({ type: "killSession", session });
  }
  newWindow(session: string, name?: string, requestId?: string, cwdFromWindowId?: string): void {
    this.send({ type: "newWindow", session, name, requestId, cwdFromWindowId });
  }
  killWindow(session: string, windowId: string): void {
    this.send({ type: "killWindow", session, windowId });
  }

  getStatus(): GatewayStatus {
    return this.status;
  }
  getSessions(): SessionInfo[] {
    return this.lastSessions;
  }

  private setStatus(s: GatewayStatus): void {
    this.status = s;
    this.statusSubs.forEach((cb) => cb(s));
  }
}
