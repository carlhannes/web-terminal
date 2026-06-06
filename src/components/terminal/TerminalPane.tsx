import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { ImageAddon } from "@xterm/addon-image";
import "@xterm/xterm/css/xterm.css";

import type { TerminalGatewayClient, GatewayStatus } from "@/lib/terminal-gateway";

interface Props {
  client: TerminalGatewayClient;
  /** tmux session name (desktop). */
  session: string;
  /** tmux window id (this terminal). */
  windowId: string;
  /** Whether this is the focused pane (drives focus + refit). */
  active: boolean;
  status: GatewayStatus;
  /** Zoom factor (1 = 100%); scales the font size and reflows the grid. */
  zoom?: number;
  onFocus?: () => void;
}

/** Font size at 100% zoom. */
const BASE_FONT_SIZE = 13;

const STATUS_LABEL: Record<GatewayStatus, string | null> = {
  open: null,
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  closed: "Disconnected",
  "auth-error": "Session expired — please sign in again",
};

// One xterm bound to one tmux window, streamed over the gateway WebSocket. tmux
// holds the real state, so on reconnect the gateway re-attaches and redraws.
export function TerminalPane({
  client,
  session,
  windowId,
  active,
  status,
  zoom = 1,
  onFocus,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Seeds the initial font size without making the build effect depend on `zoom` (which
  // would recreate the whole terminal on every zoom change). Kept in sync by the zoom effect.
  const zoomRef = useRef(zoom);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: BASE_FONT_SIZE * zoomRef.current,
      theme: {
        background: "#0a0a0a",
        foreground: "#e5e5e5",
        cursor: "#e5e5e5",
        selectionBackground: "#264f78",
      },
      allowProposedApi: true,
      scrollback: 5000,
      // tmux has mouse mode on (so the wheel scrolls scrollback), which means a plain drag
      // goes to tmux, not xterm. To still select text natively you hold a modifier: Shift on
      // Win/Linux, Option(⌥) on macOS — but on macOS xterm ALSO requires this flag (it
      // defaults off). Without it, nothing selects on a Mac while mouse mode is on.
      macOptionClickForcesSelection: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    // Handles OSC 52: apps (e.g. Claude Code) that emit `\x1b]52;c;<base64>\x07` get
    // their text written to the browser clipboard. Default provider uses
    // navigator.clipboard (requires a secure context — i.e. HTTPS or localhost).
    term.loadAddon(new ClipboardAddon());
    // Make URLs clickable (opens in a new tab).
    term.loadAddon(new WebLinksAddon());
    // Render sixel / iTerm inline images (relies on allowProposedApi, set above).
    term.loadAddon(new ImageAddon());
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    // xterm 6.0 has no kitty keyboard protocol, so we map keys by hand. Returning false
    // tells xterm to NOT process the event; returning true lets xterm handle it normally.
    // NOTE: on the keydown path xterm returns *before* its own preventDefault when the
    // handler returns false, so we must preventDefault ourselves — otherwise the browser's
    // default fires on xterm's hidden textarea and re-emits a stray byte (e.g. Shift+Enter
    // would insert a textarea newline that gets sent as CR, submitting the line).
    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      // Shift+Enter -> LF (0x0A), i.e. Ctrl+J. TUI apps like Claude Code treat this as
      // "insert newline"; plain Enter keeps sending CR (0x0D) which submits.
      if (e.key === "Enter" && e.shiftKey) {
        e.preventDefault();
        client.sendInput(session, windowId, "\n");
        return false;
      }
      // Copy the current selection on Cmd+C (macOS) or Ctrl+Shift+C. Plain Ctrl+C is left
      // alone so it still sends SIGINT.
      const isCopy = e.key.toLowerCase() === "c" && (e.metaKey || (e.ctrlKey && e.shiftKey));
      if (isCopy && term.hasSelection()) {
        e.preventDefault();
        void navigator.clipboard?.writeText(term.getSelection());
        return false;
      }
      return true;
    });
    try {
      fit.fit();
    } catch {
      /* not sized yet */
    }

    client.attachPane(session, windowId, term.cols, term.rows);
    const offOutput = client.subscribeOutput(session, windowId, (bytes) => term.write(bytes));
    const dataSub = term.onData((d) => client.sendInput(session, windowId, d));

    // Send resize only after xterm has adopted the new grid (race-free).
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const resizeSub = term.onResize(({ cols, rows }) => {
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => client.sendResize(session, windowId, cols, rows), 60);
    });

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        /* noop */
      }
    });
    ro.observe(host);

    return () => {
      if (resizeTimer) clearTimeout(resizeTimer);
      offOutput();
      dataSub.dispose();
      resizeSub.dispose();
      ro.disconnect();
      client.detachPane(session, windowId);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [client, session, windowId]);

  useEffect(() => {
    if (active) {
      requestAnimationFrame(() => {
        try {
          fitRef.current?.fit();
          termRef.current?.focus();
        } catch {
          /* noop */
        }
      });
    }
  }, [active]);

  // Apply zoom by scaling the font size; FitAddon then recomputes cols/rows and onResize
  // forwards the new grid to the gateway (the remote app reflows). Native + crisp — see
  // docs/zoom-css-scale-fallback.md for why we don't use CSS transforms.
  useEffect(() => {
    zoomRef.current = zoom;
    const term = termRef.current;
    if (!term) return;
    term.options.fontSize = BASE_FONT_SIZE * zoom;
    try {
      fitRef.current?.fit();
    } catch {
      /* not sized yet */
    }
  }, [zoom]);

  const label = STATUS_LABEL[status];
  return (
    <div className="relative h-full min-h-0 w-full min-w-0" onMouseDown={onFocus}>
      <div ref={hostRef} className="h-full min-h-0 w-full min-w-0 bg-[#0a0a0a] p-1" />
      {label && (
        <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded bg-black/70 px-2 py-0.5 text-[11px] text-amber-300">
          {label}
        </div>
      )}
    </div>
  );
}
