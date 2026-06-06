import { test } from "node:test";
import assert from "node:assert/strict";

import { tmux, parseSessions, parseWindows } from "./tmux";
import { FakeHostConnection } from "./fake-host-connection";

// The fake stands in for tmux: its exec output must round-trip through the REAL parsers the
// gateway uses, so the gateway logic runs unchanged against it.
test("FakeHostConnection.exec emulates tmux for the real parsers", async () => {
  const conn = await FakeHostConnection.connect("alice");

  // Starts empty (the real gateway creates the first desktop).
  assert.deepEqual(parseSessions((await conn.exec(tmux.listSessions())).stdout), []);

  // new-session creates a session WITH one window (like real tmux).
  await conn.exec(tmux.newSession("web-alice-1"));
  const sessions = parseSessions((await conn.exec(tmux.listSessions())).stdout);
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].name, "web-alice-1");
  assert.equal(sessions[0].windows, 1);

  let wins = parseWindows((await conn.exec(tmux.listWindows("web-alice-1"))).stdout);
  assert.equal(wins.length, 1);
  assert.match(wins[0].id, /^@\d+$/);

  // new-window returns a fresh window id and adds a window.
  const newId = (await conn.exec(tmux.newWindow("web-alice-1"))).stdout.trim();
  assert.match(newId, /^@\d+$/);
  wins = parseWindows((await conn.exec(tmux.listWindows("web-alice-1"))).stdout);
  assert.equal(wins.length, 2);

  // kill-window removes it; kill-session drops the desktop.
  await conn.exec(tmux.killWindow(newId));
  assert.equal(parseWindows((await conn.exec(tmux.listWindows("web-alice-1"))).stdout).length, 1);
  await conn.exec(tmux.killSession("web-alice-1"));
  assert.deepEqual(parseSessions((await conn.exec(tmux.listSessions())).stdout), []);
});

test("FakeHostConnection.openViewer yields a stream that banners then echoes", async () => {
  const conn = await FakeHostConnection.connect("alice");
  const stream = await conn.openViewer("web-alice-1", "_v-x", 0, { cols: 80, rows: 24 });

  const chunks: string[] = [];
  stream.on("data", (d: Buffer) => chunks.push(d.toString("utf8")));

  // Banner is emitted on a later tick (after the gateway attaches its listener).
  await new Promise((r) => setTimeout(r, 5));
  assert.match(chunks.join(""), /not a real shell/);

  // Typing a line + Enter echoes and reports "command not found".
  chunks.length = 0;
  stream.write("foo\r");
  assert.match(chunks.join(""), /foo/);
  assert.match(chunks.join(""), /command not found/);
});
