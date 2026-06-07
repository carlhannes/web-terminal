import { useRef, useState } from "react";
import { Keyboard, ChevronLeft } from "lucide-react";

import { ZoomSelect } from "./ZoomSelect";

interface Props {
  /** Send a raw byte string to the active pane (already wired to client.sendInput). */
  onKey: (data: string) => void;
  /** Active pane's zoom factor (1 = 100%). */
  zoom: number;
  onZoomChange: (zoom: number) => void;
}

// Keys the soft keyboard can't produce, sent as raw VT sequences. Edit to taste — this
// is the single source of the on-screen key set. Order = display order.
const KEYS: { label: string; data: string; wide?: boolean }[] = [
  { label: "Esc", data: "\x1b", wide: true },
  { label: "Tab", data: "\t", wide: true },
  { label: "Ctrl-C", data: "\x03", wide: true },
  { label: "Ctrl-D", data: "\x04", wide: true },
  { label: "Ctrl-Z", data: "\x1a", wide: true },
  { label: "Ctrl-L", data: "\x0c", wide: true },
  { label: "Ctrl-R", data: "\x12", wide: true },
  { label: "←", data: "\x1b[D" },
  { label: "↑", data: "\x1b[A" },
  { label: "↓", data: "\x1b[B" },
  { label: "→", data: "\x1b[C" },
  { label: "|", data: "|" },
  { label: "/", data: "/" },
  { label: "~", data: "~" },
  { label: "-", data: "-" },
];

// Past this much finger travel (px) a press is a scroll/swipe, not a tap, so it's cancelled.
const MOVE_CANCEL = 10;

// Accessory bar for touch devices. Two states sharing one row:
//   collapsed → [zoom] [Shortcuts]      (zoom is always visible)
//   expanded  → [Back] [Esc][Tab]…      (the full raw-key set)
// Key presses fire on pointer-UP only when the gesture stayed a tap (armed on down, cancelled
// by a scroll/swipe), so swiping the scrollable key row no longer sends a stray Ctrl-C. We
// still preventDefault on pointer-down so the xterm textarea keeps focus and the soft keyboard
// does not dismiss between taps.
export function MobileKeyBar({ onKey, zoom, onZoomChange }: Props) {
  const [expanded, setExpanded] = useState(false);
  // The in-flight press for the key currently under the finger (null = nothing armed).
  const press = useRef<{ id: number; x: number; y: number; data: string } | null>(null);

  const disarm = () => {
    press.current = null;
  };
  const onContainerMove = (e: React.PointerEvent) => {
    const p = press.current;
    if (p && p.id === e.pointerId && Math.hypot(e.clientX - p.x, e.clientY - p.y) > MOVE_CANCEL) {
      press.current = null; // became a scroll/swipe
    }
  };

  return (
    <div
      className="mobile-bottom-stack flex shrink-0 items-center gap-1 overflow-x-auto border-t border-border bg-card px-1 py-1"
      onPointerMove={onContainerMove}
      onPointerCancel={disarm}
    >
      {expanded ? (
        <>
          <button
            type="button"
            tabIndex={-1}
            aria-label="Hide shortcuts"
            onPointerDown={(e) => {
              e.preventDefault();
              setExpanded(false);
            }}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-md border border-border bg-background text-foreground active:bg-muted"
          >
            <ChevronLeft size={18} />
          </button>
          {KEYS.map((k) => (
            <button
              key={k.label}
              type="button"
              tabIndex={-1}
              aria-label={k.label}
              onPointerDown={(e) => {
                e.preventDefault(); // keep xterm focus; soft keyboard stays up
                press.current = { id: e.pointerId, x: e.clientX, y: e.clientY, data: k.data };
              }}
              onPointerUp={(e) => {
                const p = press.current;
                press.current = null;
                if (p && p.id === e.pointerId && p.data === k.data) onKey(k.data);
              }}
              onPointerCancel={disarm}
              className={`flex h-11 shrink-0 items-center justify-center rounded-md border border-border bg-background font-mono text-sm text-foreground active:bg-muted ${
                k.wide ? "px-3" : "w-11"
              }`}
            >
              {k.label}
            </button>
          ))}
        </>
      ) : (
        <>
          <ZoomSelect value={zoom} onChange={onZoomChange} />
          <button
            type="button"
            tabIndex={-1}
            aria-label="Show shortcuts"
            onPointerDown={(e) => {
              e.preventDefault();
              setExpanded(true);
            }}
            className="flex h-11 shrink-0 items-center justify-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm text-foreground active:bg-muted"
          >
            <Keyboard size={16} /> Shortcuts
          </button>
        </>
      )}
    </div>
  );
}
