import { Group, Panel, Separator } from "react-resizable-panels";
import { SplitSquareHorizontal, SplitSquareVertical, X } from "lucide-react";

import type { LayoutNode, LayoutPath } from "./types";
import { TerminalPane } from "./TerminalPane";
import type { TerminalGatewayClient, GatewayStatus } from "@/lib/terminal-gateway";

interface Props {
  node: LayoutNode;
  session: string;
  client: TerminalGatewayClient;
  status: GatewayStatus;
  /** Focused pane within the tab (for highlight + focus). */
  activeWindowId: string | null;
  /** Path of this node from the tree root (for size persistence). */
  path?: LayoutPath;
  onFocus: (windowId: string) => void;
  onSplit: (windowId: string, direction: "horizontal" | "vertical") => void;
  onClose: (windowId: string) => void;
  onResize: (path: LayoutPath, sizes: [number, number]) => void;
}

// Renders the best-effort web split layout. Leaves are tmux windows; splits are a
// web-only presentation persisted in the sidecar (tmux owns the windows themselves).
export function PaneTree(props: Props) {
  const { node } = props;
  const path = props.path ?? [];

  if (node.kind === "leaf") {
    const active = node.windowId === props.activeWindowId;
    return (
      <div
        className={`group relative h-full w-full border ${active ? "border-primary/60" : "border-transparent"}`}
      >
        <div className="pointer-events-none absolute right-1 top-1 z-10 flex gap-1 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
          <IconBtn title="Split right" onClick={() => props.onSplit(node.windowId, "horizontal")}>
            <SplitSquareHorizontal size={12} />
          </IconBtn>
          <IconBtn title="Split down" onClick={() => props.onSplit(node.windowId, "vertical")}>
            <SplitSquareVertical size={12} />
          </IconBtn>
          <IconBtn title="Close terminal" onClick={() => props.onClose(node.windowId)}>
            <X size={12} />
          </IconBtn>
        </div>
        <TerminalPane
          client={props.client}
          session={props.session}
          windowId={node.windowId}
          active={active}
          status={props.status}
          onFocus={() => props.onFocus(node.windowId)}
        />
      </div>
    );
  }

  const idA = `${pathKey(path)}/a`;
  const idB = `${pathKey(path)}/b`;
  return (
    <Group
      orientation={node.direction}
      className="flex h-full w-full"
      onLayoutChanged={(layout) => {
        // Layout is a map of panel id -> flexGrow; normalize the two children to percentages.
        const a = layout[idA];
        const b = layout[idB];
        if (typeof a === "number" && typeof b === "number" && a + b > 0) {
          const total = a + b;
          props.onResize(path, [(a / total) * 100, (b / total) * 100]);
        }
      }}
    >
      <Panel id={idA} defaultSize={node.sizes[0]} minSize={10}>
        <PaneTree {...props} node={node.a} path={[...path, "a"]} />
      </Panel>
      <Separator
        className={
          node.direction === "horizontal"
            ? "w-px shrink-0 cursor-col-resize bg-border hover:bg-primary/60"
            : "h-px shrink-0 cursor-row-resize bg-border hover:bg-primary/60"
        }
      />
      <Panel id={idB} defaultSize={node.sizes[1]} minSize={10}>
        <PaneTree {...props} node={node.b} path={[...path, "b"]} />
      </Panel>
    </Group>
  );
}

function pathKey(path: LayoutPath): string {
  return path.length ? path.join("-") : "root";
}

function IconBtn({
  children,
  onClick,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="rounded border border-border bg-card/80 p-1 text-muted-foreground hover:bg-card hover:text-foreground"
    >
      {children}
    </button>
  );
}
