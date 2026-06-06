// Per-pane zoom levels (fraction; 1 = 100%). Single source for the level list.
const ZOOM_LEVELS = [0.5, 0.6, 0.7, 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4, 1.5];

interface Props {
  value: number;
  onChange: (zoom: number) => void;
}

// Native <select> zoom picker, styled to match the pane control buttons. Native is the
// platform-natural, accessible dropdown — no custom menu needed.
export function ZoomSelect({ value, onChange }: Props) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      title="Zoom level"
      aria-label="Zoom level"
      className="cursor-pointer rounded border border-border bg-card/80 px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-card hover:text-foreground"
    >
      {ZOOM_LEVELS.map((z) => (
        <option key={z} value={z}>
          {Math.round(z * 100)}%
        </option>
      ))}
    </select>
  );
}
