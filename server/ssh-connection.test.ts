import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyConnectError } from "./ssh-connection";

// ssh2 tags connect errors with a `level` (see ssh2/lib/client.js). The classifier turns
// those into a coarse reason so the auth catch site can log/return the real cause instead
// of collapsing everything into "authentication failed".
test("classifyConnectError maps bad credentials", () => {
  const r = classifyConnectError({
    level: "client-authentication",
    message: "All configured authentication methods failed",
  });
  assert.equal(r.reason, "bad-credentials");
  assert.match(r.detail, /client-authentication/);
});

test("classifyConnectError maps unreachable host (socket / dns / timeout)", () => {
  assert.equal(
    classifyConnectError({
      level: "client-socket",
      code: "ECONNREFUSED",
      message: "connect ECONNREFUSED",
    }).reason,
    "host-unreachable",
  );
  assert.equal(
    classifyConnectError({ level: "client-dns", message: "looking up address" }).reason,
    "host-unreachable",
  );
  assert.equal(
    classifyConnectError({ level: "client-timeout", message: "Timed out" }).reason,
    "host-unreachable",
  );
});

test("classifyConnectError keeps the error code in detail", () => {
  assert.match(
    classifyConnectError({ level: "client-socket", code: "EHOSTUNREACH", message: "no route" })
      .detail,
    /code=EHOSTUNREACH/,
  );
});

test("classifyConnectError maps host-key rejection", () => {
  assert.equal(
    classifyConnectError({ level: "handshake", message: "Handshake failed" }).reason,
    "host-key",
  );
  // Also recognised via message when the level is absent.
  assert.equal(
    classifyConnectError({ message: "Host key verification failed" }).reason,
    "host-key",
  );
});

test("classifyConnectError falls back to 'other' and never throws on odd input", () => {
  assert.equal(classifyConnectError({}).reason, "other");
  assert.equal(classifyConnectError(null).reason, "other");
  assert.equal(classifyConnectError(new Error("boom")).reason, "other");
  assert.equal(classifyConnectError("a string").detail, "a string");
});
