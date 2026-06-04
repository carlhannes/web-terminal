import { z } from "zod";

// Shared WebSocket protocol + layout schema for the terminal gateway.
// PURE: only depends on `zod` and Web-standard APIs (TextEncoder/Decoder,
// Uint8Array) so it is safe to import from BOTH the Node gateway and the
// browser client — single source of truth for the wire format (DRY).

/** Allowed tmux session/window NAME chars (NOT used for the composite "session:windowId"). */
export const NAME_RE = /^[A-Za-z0-9_@%.-]{1,64}$/;

export function isValidName(n: string): boolean {
  return NAME_RE.test(n);
}

// ---------------------------------------------------------------------------
// Layout sidecar (best-effort web presentation persisted per user)
// ---------------------------------------------------------------------------

export type LayoutNode =
  | { kind: "leaf"; windowId: string }
  | {
      kind: "split";
      direction: "horizontal" | "vertical";
      sizes: [number, number];
      a: LayoutNode;
      b: LayoutNode;
    };

export const LayoutNodeSchema: z.ZodType<LayoutNode> = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal("leaf"), windowId: z.string() }),
    z.object({
      kind: z.literal("split"),
      direction: z.enum(["horizontal", "vertical"]),
      sizes: z.tuple([z.number(), z.number()]),
      a: LayoutNodeSchema,
      b: LayoutNodeSchema,
    }),
  ]),
);

export const LayoutTabSchema = z.object({
  id: z.string(),
  title: z.string(),
  tree: LayoutNodeSchema,
  activeWindowId: z.string(),
});
export type LayoutTab = z.infer<typeof LayoutTabSchema>;

export const DesktopLayoutSchema = z.object({
  order: z.number(),
  tabs: z.array(LayoutTabSchema),
});
export type DesktopLayout = z.infer<typeof DesktopLayoutSchema>;

export const UserLayoutSchema = z.object({
  version: z.literal(1),
  desktops: z.record(z.string(), DesktopLayoutSchema),
});
export type UserLayout = z.infer<typeof UserLayoutSchema>;

// Best-effort reconcile of a saved desktop layout against the live tmux windows.
// PURE — shared by the gateway (reconcile from disk on attach) and the client
// (merge live window changes into the in-memory arrangement). Single source of truth.
function pruneTree(node: LayoutNode, live: Set<string>): LayoutNode | null {
  if (node.kind === "leaf") return live.has(node.windowId) ? node : null;
  const a = pruneTree(node.a, live);
  const b = pruneTree(node.b, live);
  if (a && b) return { ...node, a, b };
  return a ?? b; // one side died -> collapse to the survivor
}

function leavesOf(node: LayoutNode, acc: string[] = []): string[] {
  if (node.kind === "leaf") acc.push(node.windowId);
  else {
    leavesOf(node.a, acc);
    leavesOf(node.b, acc);
  }
  return acc;
}

export function reconcileLayout(
  saved: DesktopLayout | undefined,
  windows: WindowInfo[],
  order = 0,
): DesktopLayout {
  const live = new Set(windows.map((w) => w.id));
  const referenced = new Set<string>();
  const tabs: LayoutTab[] = [];

  for (const tab of saved?.tabs ?? []) {
    const tree = pruneTree(tab.tree, live);
    if (!tree) continue;
    const leaves = leavesOf(tree);
    leaves.forEach((id) => referenced.add(id));
    const activeWindowId = leaves.includes(tab.activeWindowId) ? tab.activeWindowId : leaves[0];
    tabs.push({ ...tab, tree, activeWindowId });
  }

  // Append unknown live windows (sorted by tmux index) as plain single-leaf tabs.
  const orphans = windows.filter((w) => !referenced.has(w.id)).sort((a, b) => a.index - b.index);
  for (const w of orphans) {
    tabs.push({
      id: `tab-${w.id}`,
      title: w.name || `win ${w.index}`,
      tree: { kind: "leaf", windowId: w.id },
      activeWindowId: w.id,
    });
  }

  return { order: saved?.order ?? order, tabs };
}

// ---------------------------------------------------------------------------
// tmux snapshot info (mirrors `tmux list-sessions` / `list-windows`)
// ---------------------------------------------------------------------------

export interface SessionInfo {
  id: string;
  name: string;
  windows: number;
  created: number;
}

export interface WindowInfo {
  id: string;
  index: number;
  name: string;
  active: boolean;
}

// ---------------------------------------------------------------------------
// Client -> server control messages (JSON text frames). Validated on the server.
// ---------------------------------------------------------------------------

const Dims = {
  cols: z.number().int().positive().max(2000),
  rows: z.number().int().positive().max(2000),
};

export const ClientMsgSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("attachPane"), session: z.string(), windowId: z.string(), ...Dims }),
  z.object({ type: z.literal("detachPane"), session: z.string(), windowId: z.string() }),
  z.object({
    type: z.literal("input"),
    session: z.string(),
    windowId: z.string(),
    data: z.string(),
  }),
  z.object({ type: z.literal("resize"), session: z.string(), windowId: z.string(), ...Dims }),
  z.object({ type: z.literal("listSessions") }),
  z.object({ type: z.literal("listWindows"), session: z.string() }),
  z.object({ type: z.literal("newSession") }),
  z.object({ type: z.literal("killSession"), session: z.string() }),
  z.object({ type: z.literal("renameSession"), session: z.string(), name: z.string() }),
  z.object({
    type: z.literal("newWindow"),
    session: z.string(),
    name: z.string().optional(),
    requestId: z.string().optional(),
  }),
  z.object({ type: z.literal("killWindow"), session: z.string(), windowId: z.string() }),
  z.object({
    type: z.literal("renameWindow"),
    session: z.string(),
    windowId: z.string(),
    name: z.string(),
  }),
  z.object({ type: z.literal("getLayout"), session: z.string() }),
  z.object({ type: z.literal("saveLayout"), session: z.string(), layout: DesktopLayoutSchema }),
  z.object({ type: z.literal("ping") }),
]);
export type ClientMsg = z.infer<typeof ClientMsgSchema>;

// ---------------------------------------------------------------------------
// Server -> client messages. JSON text frames + binary OUTPUT frames (below).
// ---------------------------------------------------------------------------

export type ServerErrorScope = "auth" | "ssh" | "tmux" | "protocol" | "limit";

export type ServerMsg =
  | { type: "sessions"; sessions: SessionInfo[] }
  | { type: "windows"; session: string; windows: WindowInfo[] }
  | { type: "layout"; session: string; layout: DesktopLayout | null }
  | { type: "windowCreated"; session: string; windowId: string; requestId?: string }
  | { type: "attached"; session: string; windowId: string }
  | { type: "paneExit"; session: string; windowId: string }
  | { type: "error"; scope: ServerErrorScope; message: string }
  | { type: "pong" };

// ---------------------------------------------------------------------------
// Binary OUTPUT frame (server -> client only): raw PTY bytes tagged with the
// pane they belong to, so one WebSocket can multiplex many panes without a
// base64 tax on the hot path.  Layout: [0x01][u8 idLen][id="session:windowId"][payload]
// ---------------------------------------------------------------------------

export const OUTPUT_FRAME = 0x01;

export function encodeOutputFrame(
  session: string,
  windowId: string,
  payload: Uint8Array,
): Uint8Array {
  const idBytes = new TextEncoder().encode(`${session}:${windowId}`);
  if (idBytes.length > 255) throw new Error("pane id too long");
  const buf = new Uint8Array(2 + idBytes.length + payload.length);
  buf[0] = OUTPUT_FRAME;
  buf[1] = idBytes.length;
  buf.set(idBytes, 2);
  buf.set(payload, 2 + idBytes.length);
  return buf;
}

export interface OutputFrame {
  session: string;
  windowId: string;
  payload: Uint8Array;
}

export function decodeOutputFrame(data: Uint8Array): OutputFrame | null {
  if (data.length < 2 || data[0] !== OUTPUT_FRAME) return null;
  const idLen = data[1];
  if (data.length < 2 + idLen) return null;
  const id = new TextDecoder().decode(data.subarray(2, 2 + idLen));
  const sep = id.indexOf(":"); // session names never contain ':' (NAME_RE)
  if (sep < 0) return null;
  return {
    session: id.slice(0, sep),
    windowId: id.slice(sep + 1),
    payload: data.subarray(2 + idLen),
  };
}
