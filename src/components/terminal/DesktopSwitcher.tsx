import { Plus } from "lucide-react";

import type { SessionInfo } from "@/components/terminal/types";
import { colorForIndex } from "@/components/terminal/desktop-colors";

interface Props {
  /** "vertical" = desktop right rail; "horizontal" = mobile strip above the tabs. */
  orientation: "vertical" | "horizontal";
  sessions: SessionInfo[];
  activeSession: string | null;
  onSelect: (name: string) => void;
  onAdd: () => void;
  /** Middle-click remove — wired on the desktop rail only (no touch equivalent on mobile). */
  onRemove?: (name: string) => void;
}

// Desktop chooser, shared between the desktop right rail and the mobile top strip so the
// buttons stay a single source of truth.
export function DesktopSwitcher({
  orientation,
  sessions,
  activeSession,
  onSelect,
  onAdd,
  onRemove,
}: Props) {
  const container =
    orientation === "vertical"
      ? "flex w-12 shrink-0 flex-col items-center gap-1.5 border-l border-border bg-card py-2"
      : "flex shrink-0 items-center gap-1.5 overflow-x-auto border-b border-border bg-card px-2 py-1.5";

  return (
    <div className={container}>
      {sessions.map((d, i) => {
        const isActive = d.name === activeSession;
        const c = colorForIndex(i);
        return (
          <button
            key={d.name}
            type="button"
            onClick={() => onSelect(d.name)}
            onAuxClick={onRemove ? (e) => e.button === 1 && onRemove(d.name) : undefined}
            title={
              onRemove
                ? `Desktop ${i + 1} (${d.name}) — middle-click to remove`
                : `Desktop ${i + 1} (${d.name})`
            }
            className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-md border font-mono text-sm font-semibold transition-all"
            style={
              isActive
                ? {
                    borderColor: c,
                    backgroundColor: `color-mix(in oklch, ${c} 22%, transparent)`,
                    color: c,
                    boxShadow: `inset 0 0 0 1px ${c}`,
                  }
                : { borderColor: "var(--color-border)", color: c, opacity: 0.55 }
            }
          >
            {i + 1}
          </button>
        );
      })}
      <button
        type="button"
        onClick={onAdd}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground hover:text-foreground"
        aria-label="New desktop"
      >
        <Plus size={16} />
      </button>
    </div>
  );
}
