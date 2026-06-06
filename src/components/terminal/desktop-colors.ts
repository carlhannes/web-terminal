// 8 distinct desktop accent colors — cycled by desktop index. Single source of truth for
// desktop coloring, shared by DesktopSwitcher (the chooser buttons) and app.tsx (tab-bar
// accent). Kept in its own module so DesktopSwitcher only exports a component (react-refresh).
const DESKTOP_COLORS = [
  "oklch(0.72 0.17 250)", // blue
  "oklch(0.74 0.17 145)", // green
  "oklch(0.78 0.17 75)", // amber
  "oklch(0.68 0.22 25)", // red
  "oklch(0.70 0.20 310)", // magenta
  "oklch(0.74 0.15 195)", // cyan
  "oklch(0.76 0.18 110)", // lime
  "oklch(0.72 0.17 35)", // orange
];

export const colorForIndex = (i: number) => DESKTOP_COLORS[i % DESKTOP_COLORS.length];
