import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Plus, X, LogOut } from "lucide-react";

// 8 distinct desktop accent colors — cycled by desktop index.
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
const colorForIndex = (i: number) => DESKTOP_COLORS[i % DESKTOP_COLORS.length];

// Correlation id for newWindow requests. NOT crypto.randomUUID(): that is
// secure-context-only and is undefined over plain http://<LAN-IP>, which silently
// broke "new tab"/split while desktops (which need no id) kept working.
let _reqSeq = 0;
const nextReqId = () => `r-${Date.now().toString(36)}-${(_reqSeq++).toString(36)}`;

import {
  type DesktopLayout,
  type LayoutPath,
  leafWindowIds,
  splitLeaf,
  setSizesAtPath,
  reconcileLayout,
} from "@/components/terminal/types";
import { PaneTree } from "@/components/terminal/PaneTree";
import { TerminalPane } from "@/components/terminal/TerminalPane";
import { MobileKeyBar } from "@/components/terminal/MobileKeyBar";
import { MobilePaneSwitcher } from "@/components/terminal/MobilePaneSwitcher";
import { useTerminalGateway } from "@/hooks/useTerminalGateway";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useViewportHeight } from "@/hooks/useViewportHeight";
import { gatewayHttpBase } from "@/lib/terminal-gateway";

export const Route = createFileRoute("/app")({
  head: () => ({ meta: [{ title: "Web Terminal" }] }),
  component: AppPage,
  ssr: false,
});

type SplitIntent = {
  kind: "split";
  session: string;
  target: string;
  direction: "horizontal" | "vertical";
};
type TabIntent = { kind: "tab"; session: string };

function AppPage() {
  const { client, sessions, status } = useTerminalGateway();
  const isMobile = useIsMobile();
  const viewportHeight = useViewportHeight();

  const [layouts, setLayouts] = useState<Record<string, DesktopLayout>>({});
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [activeTabBySession, setActiveTabBySession] = useState<Record<string, string>>({});
  const [focusedWindowId, setFocusedWindowId] = useState<string | null>(null);

  const intents = useRef(new Map<string, SplitIntent | TabIntent>());
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const prevSessionNames = useRef<string[]>([]);
  const wantNewestDesktop = useRef(false);

  // ---- gateway subscriptions ----
  useEffect(() => {
    const offLayout = client.onLayout((session, layout) => {
      setLayouts((p) => ({ ...p, [session]: layout }));
    });
    const offWindows = client.onWindows((session, windows) => {
      setLayouts((p) => {
        const cur = p[session];
        return { ...p, [session]: reconcileLayout(cur, windows, cur?.order ?? 0) };
      });
    });
    const offCreated = client.onWindowCreated((session, windowId, requestId) => {
      const intent = requestId ? intents.current.get(requestId) : undefined;
      if (requestId) intents.current.delete(requestId);
      if (intent?.kind === "split") {
        setLayouts((p) => {
          const cur = p[session];
          if (!cur) return p;
          const tabs = cur.tabs.map((tab) =>
            leafWindowIds(tab.tree).includes(intent.target)
              ? {
                  ...tab,
                  tree: splitLeaf(tab.tree, intent.target, windowId, intent.direction),
                  activeWindowId: windowId,
                }
              : tab,
          );
          return { ...p, [session]: { ...cur, tabs } };
        });
      } else {
        // a new tab: reconcile names orphan tabs `tab-<windowId>` deterministically
        setActiveTabBySession((p) => ({ ...p, [session]: `tab-${windowId}` }));
      }
      setFocusedWindowId(windowId);
    });
    return () => {
      offLayout();
      offWindows();
      offCreated();
    };
  }, [client]);

  // First/changed sessions: keep a valid active desktop.
  useEffect(() => {
    const names = sessions.map((s) => s.name);
    if (wantNewestDesktop.current) {
      const added = names.find((n) => !prevSessionNames.current.includes(n));
      if (added) {
        setActiveSession(added);
        wantNewestDesktop.current = false;
      }
    }
    prevSessionNames.current = names;
    if (sessions.length > 0) {
      setActiveSession((cur) => (cur && names.includes(cur) ? cur : sessions[0].name));
    } else {
      setActiveSession(null);
    }
  }, [sessions]);

  // Load layout for the active desktop once.
  useEffect(() => {
    if (activeSession && !layouts[activeSession]) client.getLayout(activeSession);
  }, [activeSession, layouts, client]);

  // Persist layout changes for the active desktop (debounced; gateway also debounces disk).
  useEffect(() => {
    if (!activeSession) return;
    const layout = layouts[activeSession];
    if (!layout) return;
    const timers = saveTimers.current;
    const existing = timers.get(activeSession);
    if (existing) clearTimeout(existing);
    timers.set(
      activeSession,
      setTimeout(() => client.saveLayout(activeSession, layout), 800),
    );
  }, [activeSession, layouts, client]);

  // Auth expired / never authenticated -> back to login.
  useEffect(() => {
    if (status === "auth-error") window.location.href = "/login";
  }, [status]);

  // ---- derived ----
  const activeIndex = sessions.findIndex((s) => s.name === activeSession);
  const accent = colorForIndex(activeIndex >= 0 ? activeIndex : 0);
  const activeLayout = activeSession ? layouts[activeSession] : undefined;
  const tabs = activeLayout?.tabs ?? [];
  const activeTabId = activeSession ? activeTabBySession[activeSession] : undefined;
  const activeTab = tabs.find((t) => t.id === activeTabId) ?? tabs[0];

  // Mobile flattens the split tree to a single full-screen pane (the active leaf) plus a
  // switcher; the tree itself is never mutated, so the desktop split survives.
  const leaves = activeTab ? leafWindowIds(activeTab.tree) : [];
  const activeLeaf =
    focusedWindowId && leaves.includes(focusedWindowId)
      ? focusedWindowId
      : activeTab?.activeWindowId && leaves.includes(activeTab.activeWindowId)
        ? activeTab.activeWindowId
        : (leaves[0] ?? null);
  // Send raw bytes (from the mobile key bar) to the active pane.
  const sendKey = (data: string) => {
    if (activeSession && activeLeaf) client.sendInput(activeSession, activeLeaf, data);
  };

  // ---- operations ----
  function selectDesktop(name: string) {
    setActiveSession(name);
  }
  function addDesktop() {
    wantNewestDesktop.current = true;
    client.newSession();
  }
  function removeDesktop(name: string) {
    client.killSession(name);
  }
  function selectTab(tabId: string) {
    if (activeSession) setActiveTabBySession((p) => ({ ...p, [activeSession]: tabId }));
  }
  function addTab() {
    if (!activeSession) return;
    const requestId = nextReqId();
    intents.current.set(requestId, { kind: "tab", session: activeSession });
    client.newWindow(activeSession, undefined, requestId);
  }
  function closeTab(tab: DesktopLayout["tabs"][number]) {
    if (!activeSession) return;
    for (const windowId of leafWindowIds(tab.tree)) client.killWindow(activeSession, windowId);
  }
  function splitPane(windowId: string, direction: "horizontal" | "vertical") {
    if (!activeSession) return;
    const requestId = nextReqId();
    intents.current.set(requestId, {
      kind: "split",
      session: activeSession,
      target: windowId,
      direction,
    });
    client.newWindow(activeSession, undefined, requestId);
  }
  function closePane(windowId: string) {
    if (activeSession) client.killWindow(activeSession, windowId);
  }
  function resizeSplit(path: LayoutPath, sizes: [number, number]) {
    if (!activeSession || !activeTab) return;
    setLayouts((p) => {
      const cur = p[activeSession];
      if (!cur) return p;
      const tabs2 = cur.tabs.map((t) =>
        t.id === activeTab.id ? { ...t, tree: setSizesAtPath(t.tree, path, sizes) } : t,
      );
      return { ...p, [activeSession]: { ...cur, tabs: tabs2 } };
    });
  }
  async function logout() {
    try {
      await fetch(`${gatewayHttpBase()}/auth/logout`, { method: "POST", credentials: "include" });
    } catch {
      /* ignore */
    }
    client.disconnect();
    window.location.href = "/login";
  }

  const connecting = status === "connecting" || status === "reconnecting";

  return (
    <div
      className="flex h-dvh w-screen flex-col bg-background text-foreground"
      style={viewportHeight ? { height: `${viewportHeight}px` } : undefined}
    >
      {/* Tab bar */}
      <div
        className="flex h-9 shrink-0 items-end gap-1 px-2 transition-colors"
        style={{ backgroundColor: accent }}
      >
        {tabs.map((t) => {
          const isActive = t.id === activeTab?.id;
          return (
            <div
              key={t.id}
              onClick={() => selectTab(t.id)}
              className={`group relative flex h-7 cursor-pointer items-center gap-2 rounded-t-md px-3 text-xs transition-colors ${
                isActive
                  ? "text-foreground"
                  : "bg-card/40 text-muted-foreground hover:bg-card/70 hover:text-foreground"
              }`}
              style={isActive ? { backgroundColor: "#0a0a0a", marginBottom: "-1px" } : undefined}
            >
              <span className="font-mono">{t.title}</span>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t);
                }}
                className="touch-visible rounded p-0.5 opacity-0 hover:bg-muted group-hover:opacity-100"
                aria-label="Close tab"
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          onClick={addTab}
          disabled={!activeSession}
          className="ml-1 flex h-7 w-7 items-center justify-center rounded-md text-black/70 hover:bg-black/10 hover:text-black disabled:opacity-40"
          aria-label="New terminal"
        >
          <Plus size={14} />
        </button>
        <div className="ml-auto flex items-center gap-2 pr-1">
          {connecting && <span className="text-[11px] text-black/70">{status}…</span>}
          <button
            type="button"
            onClick={logout}
            className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-black/70 hover:bg-black/10 hover:text-black"
          >
            <LogOut size={12} /> sign out
          </button>
        </div>
      </div>

      {/* Body: terminal area + right desktop rail */}
      <div className="flex min-h-0 flex-1">
        <div className="relative min-w-0 flex-1">
          {activeTab && activeLeaf ? (
            isMobile ? (
              // Mobile: ignore the split layout — show only the active leaf full-screen.
              <TerminalPane
                key={activeLeaf}
                client={client}
                session={activeSession as string}
                windowId={activeLeaf}
                active
                status={status}
                onFocus={() => setFocusedWindowId(activeLeaf)}
              />
            ) : (
              <PaneTree
                node={activeTab.tree}
                session={activeSession as string}
                client={client}
                status={status}
                activeWindowId={focusedWindowId ?? activeTab.activeWindowId}
                onFocus={setFocusedWindowId}
                onSplit={splitPane}
                onClose={closePane}
                onResize={resizeSplit}
              />
            )
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {status === "open" ? "Starting your session…" : `${status}…`}
            </div>
          )}
        </div>
        <div className="flex w-12 shrink-0 flex-col items-center gap-1.5 border-l border-border bg-card py-2">
          {sessions.map((d, i) => {
            const isActive = d.name === activeSession;
            const c = colorForIndex(i);
            return (
              <button
                key={d.name}
                type="button"
                onClick={() => selectDesktop(d.name)}
                onAuxClick={(e) => {
                  if (e.button === 1) removeDesktop(d.name);
                }}
                title={`Desktop ${i + 1} (${d.name}) — middle-click to remove`}
                className="relative flex h-9 w-9 items-center justify-center rounded-md border font-mono text-sm font-semibold transition-all"
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
            onClick={addDesktop}
            className="flex h-9 w-9 items-center justify-center rounded-md border border-dashed border-border text-muted-foreground hover:text-foreground"
            aria-label="New desktop"
          >
            <Plus size={16} />
          </button>
        </div>
      </div>

      {/* Mobile bottom stack: pane switcher (only when split) + accessory key bar. */}
      {isMobile && leaves.length > 1 && (
        <MobilePaneSwitcher
          leaves={leaves}
          activeLeaf={activeLeaf}
          onSelect={setFocusedWindowId}
          onClose={closePane}
        />
      )}
      {isMobile && <MobileKeyBar onKey={sendKey} />}
    </div>
  );
}
