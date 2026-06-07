import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Plus, X, LogOut, Pencil } from "lucide-react";

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
import { DesktopSwitcher } from "@/components/terminal/DesktopSwitcher";
import { colorForIndex } from "@/components/terminal/desktop-colors";
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

/** Last path segment of an absolute path (e.g. "/home/alice/src" -> "src"). */
function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  if (!trimmed) return "/";
  const slash = trimmed.lastIndexOf("/");
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

/** Display label for a tab: the user's custom name if set, else the active window's cwd. */
function tabLabel(
  tab: { name?: string; activeWindowId: string },
  cwdByWindowId: Record<string, string>,
): string {
  const custom = tab.name?.trim();
  if (custom) return custom;
  const cwd = cwdByWindowId[tab.activeWindowId];
  return (cwd && basename(cwd)) || "Terminal";
}

function AppPage() {
  const { client, sessions, status } = useTerminalGateway();
  const isMobile = useIsMobile();
  const viewportHeight = useViewportHeight();

  const [layouts, setLayouts] = useState<Record<string, DesktopLayout>>({});
  const [activeSession, setActiveSession] = useState<string | null>(null);
  const [activeTabBySession, setActiveTabBySession] = useState<Record<string, string>>({});
  const [focusedWindowId, setFocusedWindowId] = useState<string | null>(null);
  // Live working directory per tmux window (windowId -> #{pane_current_path}); drives the
  // default tab label when the user hasn't set a custom name. Pushed by the windows poll.
  const [cwdByWindowId, setCwdByWindowId] = useState<Record<string, string>>({});
  // Inline tab rename: the tab currently being edited (null = none).
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  // Right-click tab context menu (viewport coords), or null when closed.
  const [tabMenu, setTabMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);

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
      setCwdByWindowId((prev) => {
        const next = { ...prev };
        for (const w of windows) next[w.id] = w.cwd;
        return next;
      });
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

  // On reconnect (e.g. gateway restart), re-apply the disk-authoritative layout. The
  // in-memory split tree survives the reconnect but `onWindows` reconciles can flatten it
  // against a transient windows snapshot; re-fetching restores the saved splits. (Initial
  // connect — prev "connecting" — is handled by the load-once effect above, not here.)
  const prevStatus = useRef(status);
  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = status;
    if (status === "open" && (prev === "reconnecting" || prev === "closed") && activeSession) {
      client.getLayout(activeSession);
    }
  }, [status, activeSession, client]);

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

  // Escape closes the tab context menu (click-away is handled by its backdrop).
  useEffect(() => {
    if (!tabMenu) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setTabMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabMenu]);

  // ---- derived ----
  const activeIndex = sessions.findIndex((s) => s.name === activeSession);
  const accent = colorForIndex(activeIndex >= 0 ? activeIndex : 0);
  const activeLayout = activeSession ? layouts[activeSession] : undefined;
  const zoomByWindowId = activeLayout?.windowZooms ?? {};
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
  // Zoom is stored on the desktop layout (windowId -> factor), so it rides the existing
  // debounced saveLayout and persists per window.
  function setZoom(windowId: string, zoom: number) {
    if (!activeSession) return;
    setLayouts((p) => {
      const cur = p[activeSession];
      if (!cur) return p;
      return {
        ...p,
        [activeSession]: { ...cur, windowZooms: { ...cur.windowZooms, [windowId]: zoom } },
      };
    });
  }
  // Custom tab label (web-only). Stored on the layout tab so it rides the existing debounced
  // saveLayout, exactly like setZoom. Empty/whitespace clears it -> back to the live cwd default.
  function setTabName(tabId: string, name: string) {
    if (!activeSession) return;
    const trimmed = name.trim();
    setLayouts((p) => {
      const cur = p[activeSession];
      if (!cur) return p;
      const tabs = cur.tabs.map((t) => (t.id === tabId ? { ...t, name: trimmed || undefined } : t));
      return { ...p, [activeSession]: { ...cur, tabs } };
    });
  }
  function beginRename(tabId: string) {
    setTabMenu(null);
    setEditingTabId(tabId);
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
      className="app-shell flex h-svh w-full flex-col bg-background text-foreground"
      style={viewportHeight ? { height: `${viewportHeight}px` } : undefined}
    >
      {/* Mobile: desktop chooser as a horizontal strip above the tabs (the right rail is
          hidden on mobile). */}
      {isMobile && (
        <DesktopSwitcher
          orientation="horizontal"
          sessions={sessions}
          activeSession={activeSession}
          onSelect={selectDesktop}
          onAdd={addDesktop}
        />
      )}

      {/* Tab bar */}
      <div
        className="flex h-9 shrink-0 items-end gap-1 px-2 transition-colors"
        style={{ backgroundColor: accent }}
      >
        {tabs.map((t) => {
          const isActive = t.id === activeTab?.id;
          const editing = editingTabId === t.id;
          return (
            <div
              key={t.id}
              onClick={() => !editing && selectTab(t.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setEditingTabId(null);
                setTabMenu({ tabId: t.id, x: e.clientX, y: e.clientY });
              }}
              className={`group relative flex h-7 cursor-pointer items-center gap-2 rounded-t-md px-3 text-xs transition-colors ${
                isActive
                  ? "text-foreground"
                  : "bg-card/40 text-muted-foreground hover:bg-card/70 hover:text-foreground"
              }`}
              style={isActive ? { backgroundColor: "#0a0a0a", marginBottom: "-1px" } : undefined}
            >
              {editing ? (
                <input
                  autoFocus
                  defaultValue={t.name ?? ""}
                  placeholder={tabLabel(t, cwdByWindowId)}
                  onClick={(e) => e.stopPropagation()}
                  onFocus={(e) => e.currentTarget.select()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      setTabName(t.id, e.currentTarget.value);
                      setEditingTabId(null);
                    } else if (e.key === "Escape") {
                      setEditingTabId(null);
                    }
                  }}
                  onBlur={(e) => {
                    setTabName(t.id, e.currentTarget.value);
                    setEditingTabId(null);
                  }}
                  // text-base = 16px: below 16px iOS Safari auto-zooms on input focus.
                  className="w-24 rounded bg-black/40 px-1 font-mono text-base text-foreground outline-none ring-1 ring-primary/60"
                />
              ) : (
                <span
                  className="font-mono"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    beginRename(t.id);
                  }}
                  title="Double-click to rename"
                >
                  {tabLabel(t, cwdByWindowId)}
                </span>
              )}
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
                visible
                status={status}
                zoom={zoomByWindowId[activeLeaf] ?? 1}
                onFocus={() => setFocusedWindowId(activeLeaf)}
              />
            ) : (
              // Desktop: keep EVERY tab of the active desktop mounted and attached, showing
              // only the active one. Hidden tabs use visibility:hidden (NOT display:none) so
              // they keep their box size — xterm/FitAddon stay correctly sized, so switching
              // back needs no re-attach and no tmux resize, hence no redraw flash.
              tabs.map((tab) => {
                const tabVisible = tab.id === activeTab.id;
                // Focused pane WITHIN this tab: the global focus only counts if it belongs to
                // this tab; otherwise fall back to the tab's own remembered active window so the
                // visible tab always has a pane to highlight + focus on switch.
                const tabLeaves = leafWindowIds(tab.tree);
                const focused =
                  tabVisible && focusedWindowId && tabLeaves.includes(focusedWindowId)
                    ? focusedWindowId
                    : tab.activeWindowId;
                return (
                  <div
                    key={tab.id}
                    className="absolute inset-0"
                    style={{ visibility: tabVisible ? "visible" : "hidden" }}
                    aria-hidden={!tabVisible}
                  >
                    <PaneTree
                      node={tab.tree}
                      session={activeSession as string}
                      client={client}
                      status={status}
                      visible={tabVisible}
                      activeWindowId={focused}
                      zoomByWindowId={zoomByWindowId}
                      onFocus={setFocusedWindowId}
                      onSplit={splitPane}
                      onClose={closePane}
                      onResize={resizeSplit}
                      onZoomChange={setZoom}
                    />
                  </div>
                );
              })
            )
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {status === "open" ? "Starting your session…" : `${status}…`}
            </div>
          )}
        </div>
        {/* Desktop: the chooser is the right rail. On mobile it moves to the top strip. */}
        {!isMobile && (
          <DesktopSwitcher
            orientation="vertical"
            sessions={sessions}
            activeSession={activeSession}
            onSelect={selectDesktop}
            onAdd={addDesktop}
            onRemove={removeDesktop}
          />
        )}
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
      {isMobile && (
        <MobileKeyBar
          onKey={sendKey}
          zoom={activeLeaf ? (zoomByWindowId[activeLeaf] ?? 1) : 1}
          onZoomChange={(z) => activeLeaf && setZoom(activeLeaf, z)}
        />
      )}

      {/* Tab context menu (right-click). Backdrop closes it on any outside click. */}
      {tabMenu && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setTabMenu(null)}
            onContextMenu={(e) => {
              e.preventDefault();
              setTabMenu(null);
            }}
          />
          <div
            className="fixed z-50 min-w-32 overflow-hidden rounded-md border border-border bg-card py-1 text-xs shadow-lg"
            style={{ left: tabMenu.x, top: tabMenu.y }}
          >
            <button
              type="button"
              onClick={() => beginRename(tabMenu.tabId)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-muted"
            >
              <Pencil size={12} /> Rename
            </button>
            <button
              type="button"
              onClick={() => {
                const tab = tabs.find((t) => t.id === tabMenu.tabId);
                setTabMenu(null);
                if (tab) closeTab(tab);
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-red-400 hover:bg-muted"
            >
              <X size={12} /> Close
            </button>
          </div>
        </>
      )}
    </div>
  );
}
