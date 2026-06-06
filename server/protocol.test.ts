import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ClientMsgSchema,
  encodeOutputFrame,
  decodeOutputFrame,
  reconcileLayout,
  type DesktopLayout,
  type WindowInfo,
} from "./protocol";

test("ClientMsgSchema accepts valid messages", () => {
  assert.ok(ClientMsgSchema.safeParse({ type: "ping" }).success);
  assert.ok(
    ClientMsgSchema.safeParse({
      type: "attachPane",
      session: "web-a-1",
      windowId: "@0",
      cols: 80,
      rows: 24,
    }).success,
  );
  assert.ok(
    ClientMsgSchema.safeParse({ type: "input", session: "web-a-1", windowId: "@0", data: "ls\n" })
      .success,
  );
});

test("ClientMsgSchema rejects malformed messages", () => {
  assert.ok(!ClientMsgSchema.safeParse({ type: "nope" }).success);
  assert.ok(
    !ClientMsgSchema.safeParse({
      type: "attachPane",
      session: "x",
      windowId: "@0",
      cols: 0,
      rows: 24,
    }).success,
  );
  assert.ok(
    !ClientMsgSchema.safeParse({ type: "resize", session: "x", windowId: "@0", cols: -5, rows: 24 })
      .success,
  );
});

test("output frame round-trips session + windowId + payload", () => {
  const payload = new TextEncoder().encode("hello \x1b[31mworld\x1b[0m");
  const frame = encodeOutputFrame("web-alice-1", "@7", payload);
  const decoded = decodeOutputFrame(frame);
  assert.ok(decoded);
  assert.equal(decoded.session, "web-alice-1");
  assert.equal(decoded.windowId, "@7");
  assert.deepEqual(Array.from(decoded.payload), Array.from(payload));
});

test("decodeOutputFrame returns null on non-output bytes", () => {
  assert.equal(decodeOutputFrame(new Uint8Array([0x00, 1, 2])), null);
});

const win = (id: string, index: number, name = "sh"): WindowInfo => ({
  id,
  index,
  name,
  active: false,
});

test("reconcileLayout: no saved layout -> one tab per window, in index order", () => {
  const out = reconcileLayout(undefined, [win("@1", 1), win("@0", 0)]);
  assert.equal(out.tabs.length, 2);
  assert.deepEqual(out.tabs[0].tree, { kind: "leaf", windowId: "@0" });
  assert.deepEqual(out.tabs[1].tree, { kind: "leaf", windowId: "@1" });
});

test("reconcileLayout: collapses a split when one side's window is gone", () => {
  const saved: DesktopLayout = {
    order: 0,
    tabs: [
      {
        id: "tab-1",
        title: "code",
        activeWindowId: "@0",
        tree: {
          kind: "split",
          direction: "horizontal",
          sizes: [50, 50],
          a: { kind: "leaf", windowId: "@0" },
          b: { kind: "leaf", windowId: "@1" },
        },
      },
    ],
  };
  const out = reconcileLayout(saved, [win("@0", 0)]); // @1 gone
  assert.equal(out.tabs.length, 1);
  assert.deepEqual(out.tabs[0].tree, { kind: "leaf", windowId: "@0" });
});

test("reconcileLayout: drops empty tabs and appends unknown windows", () => {
  const saved: DesktopLayout = {
    order: 2,
    tabs: [
      { id: "t", title: "dead", activeWindowId: "@9", tree: { kind: "leaf", windowId: "@9" } },
    ],
  };
  const out = reconcileLayout(saved, [win("@0", 0, "zsh")]); // @9 gone, @0 new
  assert.equal(out.order, 2);
  assert.equal(out.tabs.length, 1);
  assert.deepEqual(out.tabs[0].tree, { kind: "leaf", windowId: "@0" });
  assert.equal(out.tabs[0].title, "zsh");
});

test("reconcileLayout: empty windows snapshot keeps the saved split tree intact", () => {
  const saved: DesktopLayout = {
    order: 0,
    tabs: [
      {
        id: "tab-1",
        title: "code",
        activeWindowId: "@0",
        tree: {
          kind: "split",
          direction: "horizontal",
          sizes: [50, 50],
          a: { kind: "leaf", windowId: "@0" },
          b: { kind: "leaf", windowId: "@1" },
        },
      },
    ],
  };
  // A transient/stale empty list (e.g. right after a gateway restart) must NOT flatten.
  assert.deepEqual(reconcileLayout(saved, []), saved);
});

test("reconcileLayout: carries per-window zoom and prunes orphaned windows", () => {
  const saved: DesktopLayout = {
    order: 0,
    tabs: [{ id: "t", title: "a", activeWindowId: "@0", tree: { kind: "leaf", windowId: "@0" } }],
    windowZooms: { "@0": 1.5, "@9": 0.5 }, // @9 no longer exists
  };
  const out = reconcileLayout(saved, [win("@0", 0)]);
  assert.deepEqual(out.windowZooms, { "@0": 1.5 }); // @0 kept, @9 pruned
});

test("reconcileLayout: omits windowZooms when none survive", () => {
  const saved: DesktopLayout = {
    order: 0,
    tabs: [{ id: "t", title: "a", activeWindowId: "@0", tree: { kind: "leaf", windowId: "@0" } }],
    windowZooms: { "@9": 0.7 },
  };
  const out = reconcileLayout(saved, [win("@0", 0)]);
  assert.equal(out.windowZooms, undefined);
});
