import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
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
  onFocus?: () => void;
}

const STATUS_LABEL: Record<GatewayStatus, string | null> = {
  open: null,
  connecting: "Connecting…",
  reconnecting: "Reconnecting…",
  closed: "Disconnected",
  "auth-error": "Session expired — please sign in again",
};

// One xterm bound to one tmux window, streamed over the gateway WebSocket. tmux
// holds the real state, so on reconnect the gateway re-attaches and redraws.
export function TerminalPane({ client, session, windowId, active, status, onFocus }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      theme: {
        background: "#0a0a0a",
        foreground: "#e5e5e5",
        cursor: "#e5e5e5",
        selectionBackground: "#264f78",
      },
      allowProposedApi: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
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

  const label = STATUS_LABEL[status];
  return (
    <div className="relative h-full w-full" onMouseDown={onFocus}>
      <div ref={hostRef} className="h-full w-full bg-[#0a0a0a] p-1" />
      {label && (
        <div className="pointer-events-none absolute left-1/2 top-2 -translate-x-1/2 rounded bg-black/70 px-2 py-0.5 text-[11px] text-amber-300">
          {label}
        </div>
      )}
    </div>
  );
}
