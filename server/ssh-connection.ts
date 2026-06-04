import { Client, type ClientChannel, type ConnectConfig } from "ssh2";

import type { GatewayConfig } from "./config";
import { tmux } from "./tmux";
import { log } from "./log";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface Dims {
  cols: number;
  rows: number;
}

// One ssh2 connection per authenticated user, reused for many channels:
// short-lived `exec` channels for tmux control ops (serialized) and one
// interactive shell channel per attached pane (the live stream).
export class UserConnection {
  readonly createdAt = Date.now();
  private execQueue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private closeCbs = new Set<() => void>();

  private constructor(
    private client: Client,
    readonly username: string,
    private cfg: GatewayConfig,
  ) {
    client.on("close", () => this.handleClose());
    client.on("error", (err) => {
      log.warn("ssh connection error", { user: username, err: String(err) });
      this.handleClose();
    });
  }

  static connect(
    username: string,
    password: string,
    cfg: GatewayConfig,
    hostVerifier: ConnectConfig["hostVerifier"],
  ): Promise<UserConnection> {
    return new Promise((resolve, reject) => {
      const client = new Client();
      let settled = false;
      client.on("ready", () => {
        if (settled) return;
        settled = true;
        resolve(new UserConnection(client, username, cfg));
      });
      client.on("error", (err) => {
        if (settled) return;
        settled = true;
        reject(err);
      });
      client.connect({
        host: cfg.sshHost,
        port: cfg.sshPort,
        username,
        password,
        readyTimeout: 15_000,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 3,
        hostVerifier,
      });
    });
  }

  /** Run a tmux control command. Serialized so we never exceed a couple of channels for control ops. */
  exec(command: string): Promise<ExecResult> {
    const run = () =>
      new Promise<ExecResult>((resolve, reject) => {
        if (this.closed) return reject(new Error("connection closed"));
        this.client.exec(command, (err, stream) => {
          if (err) return reject(err);
          let stdout = "";
          let stderr = "";
          stream.on("data", (d: Buffer) => (stdout += d.toString("utf8")));
          stream.stderr.on("data", (d: Buffer) => (stderr += d.toString("utf8")));
          stream.on("close", (code: number | null) => resolve({ stdout, stderr, code: code ?? 0 }));
          stream.on("error", reject);
        });
      });
    const result = this.execQueue.then(run, run);
    this.execQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Open the live stream for a pane: create a (detached) grouped viewer session pinned
   * to `windowIndex`, then attach to it over an interactive shell channel. The gateway
   * cleans the viewer up explicitly when the pane closes (killViewer); the real windows
   * persist in the base session.
   */
  async openViewer(
    base: string,
    viewer: string,
    windowIndex: number,
    dims: Dims,
  ): Promise<ClientChannel> {
    await this.exec(tmux.ensureSession(base));
    const created = await this.exec(tmux.viewerCreate(base, viewer, windowIndex));
    if (created.code !== 0) {
      throw new Error(`viewer create failed: ${created.stderr.trim() || created.stdout.trim()}`);
    }
    const stream = await this.openShell(dims);
    // `exec` replaces the login shell with tmux so the channel closes when tmux detaches.
    stream.write(`exec ${tmux.viewerAttach(viewer)}\n`);
    return stream;
  }

  private openShell(dims: Dims): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("connection closed"));
      this.client.shell(
        { rows: dims.rows, cols: dims.cols, term: "xterm-256color" },
        (err, stream) => {
          if (err) reject(err);
          else resolve(stream);
        },
      );
    });
  }

  onClose(cb: () => void): void {
    this.closeCbs.add(cb);
  }

  private handleClose() {
    if (this.closed) return;
    this.closed = true;
    for (const cb of this.closeCbs) {
      try {
        cb();
      } catch {
        /* ignore */
      }
    }
  }

  destroy(): void {
    if (this.closed) return;
    try {
      this.client.end();
    } catch {
      /* ignore */
    }
    this.handleClose();
  }
}
