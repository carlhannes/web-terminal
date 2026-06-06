# Terminal zoom: CSS `transform: scale()` fallback (NOT the current approach)

This documents an **alternative** zoom mechanism we deliberately did **not** ship, kept as a
backup if the current approach ever proves insufficient.

## What we actually ship

Per-pane zoom changes xterm's **`fontSize`** (`fontSize = 13 × zoom`) and calls
`fitAddon.fit()` — see `src/components/terminal/TerminalPane.tsx` (the `[zoom]` effect) and
`ZoomSelect.tsx`. This is xterm's intended zoom path: text stays crisp, mouse/selection
hit-testing stays correct, and the grid reflows (zoom out → more rows/cols, zoom in →
fewer), so the remote program sees the new size. Zoom persists per window via
`windowZooms` on the saved `DesktopLayout` (`server/protocol.ts`).

## Why NOT CSS `transform: scale()`

xterm renders to a canvas and measures character size from the DOM. Under a CSS transform
that measurement is corrupted, which breaks cell sizing and **selection coordinates**, and
scaled canvas text looks blurry. See xterm.js issue
[#2488 "Character size computation is affected by CSS transforms"](https://github.com/xtermjs/xterm.js/issues/2488).
So CSS scale is the wrong tool for a *live* terminal.

## When you might still reach for it

If we ever need a **fixed-grid visual scale** (keep cols/rows constant, just shrink/grow the
whole pane visually — e.g. a thumbnail/preview, or fitting a fixed-size TUI into a small
box) then a CSS transform is appropriate. In that localized, non-interactive case
`overflow: hidden` on the wrapper is fine (unlike the app shell, where we size correctly
instead — see the `no-overflow-hidden` rule).

## Reference implementation (the iframe-preview hack this was adapted from)

`calcScale` computes a scale so a fixed `previewWidth` fits the available width; the inner
element is rendered at its natural size and visually scaled from the top-left, with the
wrapper clipping overflow.

```tsx
// Preview.tsx — scales a fixed-width iframe to fit its container.
const wPadding = 0;
const hPadding = 45;

const calcScale = ({ width, previewWidth }) => {
  if (typeof previewWidth !== "number") return 1;
  const scale = Math.min(1, 1 / (previewWidth / (width - wPadding)));
  return scale || 1;
};

// inside the component:
const [calcHeight, scale] = useMemo(() => {
  const innerScale = calcScale({ width, previewWidth });
  return [Math.min((1 / innerScale) * (height - hPadding), 9999999), innerScale];
}, [width, height, previewWidth]);

// ...
<iframe
  style={{
    width: typeof previewWidth === "number" ? `${previewWidth}px` : previewWidth,
    height: calcHeight,
    transformOrigin: "top left",
    transform: `scale(${scale})`,
  }}
/>;
```

```scss
// preview.module.scss
.previewWrapper {
  position: absolute;
  inset: 0;
  overflow: hidden; // fine here: a localized, non-interactive preview component
  text-align: center;
}
.iframeWrapper {
  width: 100%;
  height: 100%;
  iframe {
    margin: 0 auto;
    filter: drop-shadow(0 0 19px #00000033);
  }
}
```

To adapt for a terminal pane you would wrap the xterm host, render it at a fixed pixel size,
and apply `transform: scale(zoom)` + `overflow: hidden` on the wrapper — accepting the
blur/selection caveats above.
