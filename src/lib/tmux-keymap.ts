export const TMUX_PREFIX = "\x02";

export type TmuxShortcut =
  | { type: "select-window"; index: number }
  | { type: "next-window" }
  | { type: "previous-window" }
  | { type: "new-window" }
  | { type: "split-horizontal" }
  | { type: "split-vertical" }
  | { type: "close-pane" }
  | { type: "pass-through"; data: string };

function eventText(e: KeyboardEvent): string | null {
  if (isTmuxPrefix(e)) return TMUX_PREFIX;
  if (e.key.length === 1) return e.key;
  if (e.key === "Escape") return "\x1b";
  if (e.key === "Enter") return "\r";
  if (e.key === "Tab") return "\t";
  return null;
}

export function isTmuxPrefix(e: KeyboardEvent): boolean {
  return e.key.toLowerCase() === "b" && e.ctrlKey && !e.shiftKey && !e.altKey && !e.metaKey;
}

export function tmuxShortcutFromKey(e: KeyboardEvent): TmuxShortcut {
  if (/^[0-9]$/.test(e.key)) return { type: "select-window", index: Number(e.key) };

  switch (e.key) {
    case "n":
      return { type: "next-window" };
    case "p":
      return { type: "previous-window" };
    case "c":
      return { type: "new-window" };
    case "%":
      return { type: "split-horizontal" };
    case '"':
      return { type: "split-vertical" };
    case "x":
      return { type: "close-pane" };
    default:
      return { type: "pass-through", data: TMUX_PREFIX + (eventText(e) ?? "") };
  }
}
