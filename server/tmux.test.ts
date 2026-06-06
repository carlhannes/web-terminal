import { test } from "node:test";
import assert from "node:assert/strict";

import {
  sanitizeUser,
  sessionPrefix,
  ownsSession,
  nextSessionName,
  parseSessions,
  parseWindows,
  isValidName,
  isWindowIndex,
  isViewerSession,
  tmux,
} from "./tmux";

test("sanitizeUser strips unsafe chars and lowercases", () => {
  assert.equal(sanitizeUser("Alice"), "alice");
  assert.equal(sanitizeUser("a b/c.d"), "a_b_c_d");
  assert.equal(sanitizeUser(""), "user");
});

test("sessionPrefix / ownsSession", () => {
  assert.equal(sessionPrefix("alice", "web"), "web-alice-");
  assert.ok(ownsSession("web-alice-1", "alice", "web"));
  assert.ok(!ownsSession("web-bob-1", "alice", "web"));
  assert.ok(!ownsSession("web-alice-1; rm -rf", "alice", "web")); // invalid chars rejected
});

test("nextSessionName finds the lowest free number", () => {
  assert.equal(nextSessionName([], "alice", "web"), "web-alice-1");
  assert.equal(nextSessionName(["web-alice-1", "web-alice-3"], "alice", "web"), "web-alice-2");
  assert.equal(nextSessionName(["web-alice-1", "web-alice-2"], "alice", "web"), "web-alice-3");
  // ignores other users' sessions
  assert.equal(nextSessionName(["web-bob-1"], "alice", "web"), "web-alice-1");
});

test("name / index validators", () => {
  assert.ok(isValidName("web-alice-1"));
  assert.ok(isValidName("@3"));
  assert.ok(!isValidName("a b")); // space
  assert.ok(!isValidName("a;b")); // semicolon
  assert.ok(!isValidName("a'b")); // quote
  assert.ok(isWindowIndex(0));
  assert.ok(isWindowIndex(7));
  assert.ok(!isWindowIndex(-1));
  assert.ok(!isWindowIndex(1.5));
});

test("isViewerSession", () => {
  assert.ok(isViewerSession("_v-abc123"));
  assert.ok(!isViewerSession("web-alice-1"));
});

test("parseSessions parses separated output", () => {
  const out = "$0|web-alice-1|2|1700000000\n$1|_v-abc|1|1700000001\n";
  const sessions = parseSessions(out);
  assert.equal(sessions.length, 2);
  assert.deepEqual(sessions[0], { id: "$0", name: "web-alice-1", windows: 2, created: 1700000000 });
  assert.equal(sessions[1].name, "_v-abc");
});

test("parseWindows parses and reads active flag from last field", () => {
  const out = "@0|0|zsh|1\n@1|1|vim|0\n";
  const windows = parseWindows(out);
  assert.equal(windows.length, 2);
  assert.deepEqual(windows[0], { id: "@0", index: 0, name: "zsh", active: true });
  assert.deepEqual(windows[1], { id: "@1", index: 1, name: "vim", active: false });
});

test("parseWindows keeps a separator that appears inside a window name", () => {
  const windows = parseWindows("@0|0|a|b|1\n");
  assert.equal(windows.length, 1);
  assert.deepEqual(windows[0], { id: "@0", index: 0, name: "a|b", active: true });
});

test("command builders quote pre-validated tokens", () => {
  assert.equal(tmux.newSession("web-alice-1"), "tmux new-session -d -s 'web-alice-1'");
  assert.equal(tmux.killWindow("@3"), "tmux kill-window -t '@3'");
  assert.equal(
    tmux.newWindow("web-alice-1"),
    "tmux new-window -t 'web-alice-1' -P -F '#{window_id}'",
  );
  assert.equal(
    tmux.newWindow("web-alice-1", "logs"),
    "tmux new-window -t 'web-alice-1' -n 'logs' -P -F '#{window_id}'",
  );
  assert.match(tmux.listSessions(), /list-sessions/);
  assert.match(
    tmux.viewerCreate("web-alice-1", "_v-abc", 2),
    /new-session -d -t 'web-alice-1' -s '_v-abc'/,
  );
  // Must NOT set destroy-unattached: tmux would destroy the detached viewer before attach.
  assert.ok(!tmux.viewerCreate("web-alice-1", "_v-abc", 2).includes("destroy-unattached"));
  assert.match(tmux.viewerCreate("web-alice-1", "_v-abc", 2), /select-window -t '_v-abc:2'/);
  // mouse on, scoped to the viewer (per-session, not -g) so the wheel scrolls scrollback.
  assert.match(tmux.viewerCreate("web-alice-1", "_v-abc", 2), /set-option -t '_v-abc' mouse on/);
});

test("configureServer: passthrough + clipboard forwarding, and trims plain-drag/right-click", () => {
  const cmd = tmux.configureServer();
  assert.match(cmd, /set-option -g allow-passthrough on/);
  assert.match(cmd, /set-option -g set-clipboard on/);
  // No tmux auto-copy on plain drag, no right-click menu (native selection is modifier+drag).
  assert.match(cmd, /unbind-key -n MouseDrag1Pane/);
  assert.match(cmd, /unbind-key -n MouseDown3Pane/);
  // The wheel must still scroll, so its bindings stay.
  assert.ok(!cmd.includes("WheelUpPane"));
});

test("list formats use a printable separator that tmux preserves (not a tab)", () => {
  // Regression: tmux replaces control chars (incl. a tab) in -F output, so rows came back
  // unsplittable. A printable "|" round-trips.
  assert.ok(tmux.listSessions().includes("#{session_id}|#{session_name}"));
  assert.ok(!tmux.listSessions().includes("\t"));
  assert.ok(tmux.listWindows("web-alice-1").includes("#{window_id}|#{window_index}"));
});
