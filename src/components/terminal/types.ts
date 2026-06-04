// Client-facing terminal types. The tmux gateway is the source of truth for which
// sessions (desktops) and windows (terminals) exist; the split-tree layout is a
// best-effort WEB presentation persisted in the sidecar. Shared wire/layout shapes
// come from server/protocol.ts (single source of truth).

export type {
  SessionInfo,
  WindowInfo,
  LayoutNode,
  LayoutTab,
  DesktopLayout,
} from "../../../server/protocol";
export { reconcileLayout } from "../../../server/protocol";

import type { LayoutNode } from "../../../server/protocol";

/** Path to a split node: list of branches ("a"/"b") to descend from the tree root. */
export type LayoutPath = ("a" | "b")[];

export function leafWindowIds(node: LayoutNode, acc: string[] = []): string[] {
  if (node.kind === "leaf") acc.push(node.windowId);
  else {
    leafWindowIds(node.a, acc);
    leafWindowIds(node.b, acc);
  }
  return acc;
}

/** Replace the leaf for `targetWindowId` with a split of [it, newWindow]. */
export function splitLeaf(
  node: LayoutNode,
  targetWindowId: string,
  newWindowId: string,
  direction: "horizontal" | "vertical",
): LayoutNode {
  if (node.kind === "leaf") {
    if (node.windowId !== targetWindowId) return node;
    return {
      kind: "split",
      direction,
      sizes: [50, 50],
      a: node,
      b: { kind: "leaf", windowId: newWindowId },
    };
  }
  return {
    ...node,
    a: splitLeaf(node.a, targetWindowId, newWindowId, direction),
    b: splitLeaf(node.b, targetWindowId, newWindowId, direction),
  };
}

/** Remove a leaf, collapsing the split to its surviving sibling. Returns null if empty. */
export function removeLeaf(node: LayoutNode, windowId: string): LayoutNode | null {
  if (node.kind === "leaf") return node.windowId === windowId ? null : node;
  const a = removeLeaf(node.a, windowId);
  const b = removeLeaf(node.b, windowId);
  if (a && b) return { ...node, a, b };
  return a ?? b;
}

/** Update the sizes of the split node at `path` (empty path = the root split). */
export function setSizesAtPath(
  node: LayoutNode,
  path: LayoutPath,
  sizes: [number, number],
  depth = 0,
): LayoutNode {
  if (node.kind !== "split") return node;
  if (depth === path.length) return { ...node, sizes };
  return path[depth] === "a"
    ? { ...node, a: setSizesAtPath(node.a, path, sizes, depth + 1) }
    : { ...node, b: setSizesAtPath(node.b, path, sizes, depth + 1) };
}
