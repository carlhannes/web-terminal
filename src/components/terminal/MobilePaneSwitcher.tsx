import { X } from "lucide-react";

interface Props {
  /** Leaf window ids of the active tab, in tree order. */
  leaves: string[];
  /** Currently shown leaf. */
  activeLeaf: string | null;
  onSelect: (windowId: string) => void;
  onClose: (windowId: string) => void;
}

// On mobile the split tree is not tiled; instead each leaf (pane) is shown full-screen
// and selected here. Renders numbered chips 1..n in tree order. Caller only mounts this
// when leaves.length > 1, so a desktop-made split stays reachable on a phone.
export function MobilePaneSwitcher({ leaves, activeLeaf, onSelect, onClose }: Props) {
  return (
    <div className="mobile-bottom-stack flex shrink-0 items-center gap-1 overflow-x-auto border-t border-border bg-card px-1 py-1">
      <span className="shrink-0 px-1 text-[11px] text-muted-foreground">panes</span>
      {leaves.map((id, i) => {
        const isActive = id === activeLeaf;
        return (
          <div
            key={id}
            className={`flex h-9 shrink-0 items-center gap-1 rounded-md border pl-3 pr-1 text-sm ${
              isActive
                ? "border-primary/60 bg-muted text-foreground"
                : "border-border text-muted-foreground"
            }`}
          >
            <button
              type="button"
              onClick={() => onSelect(id)}
              className="font-mono"
              aria-label={`Pane ${i + 1}`}
            >
              {i + 1}
            </button>
            <button
              type="button"
              onClick={() => onClose(id)}
              className="rounded p-0.5 hover:bg-background"
              aria-label={`Close pane ${i + 1}`}
            >
              <X size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
