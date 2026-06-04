interface Props {
  /** Send a raw byte string to the active pane (already wired to client.sendInput). */
  onKey: (data: string) => void;
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

// Accessory key row for touch devices. Fires on pointerdown with preventDefault so the
// xterm hidden textarea keeps focus and the soft keyboard does NOT dismiss between taps.
export function MobileKeyBar({ onKey }: Props) {
  return (
    <div className="mobile-bottom-stack flex shrink-0 gap-1 overflow-x-auto border-t border-border bg-card px-1 py-1">
      {KEYS.map((k) => (
        <button
          key={k.label}
          type="button"
          tabIndex={-1}
          aria-label={k.label}
          onPointerDown={(e) => {
            e.preventDefault();
            onKey(k.data);
          }}
          className={`flex h-11 shrink-0 items-center justify-center rounded-md border border-border bg-background font-mono text-sm text-foreground active:bg-muted ${
            k.wide ? "px-3" : "w-11"
          }`}
        >
          {k.label}
        </button>
      ))}
    </div>
  );
}
