import assert from "node:assert/strict";
import test from "node:test";

import {
  acceptCancel,
  acceptResult,
  advanceSession,
  emacsOpenExpression,
  emacsStartProjectExpression,
  makeRequest,
} from "./protocol.js";

function requestFixture(overrides = {}) {
  return makeRequest({
    id: "rv-1",
    createdAt: "2026-11-17T04:00:00.000Z",
    repo: {
      root: "/work/repo/",
      machine: null,
      head: "abc123",
      fingerprint: "fp-1",
    },
    files: [
      { path: "src/b.ts", status: "M" },
      { path: "src/a.ts", status: "A" },
    ],
    target: {
      address: "t7",
      app: "traecli",
      title: "Fix login",
      space: "sp-1",
      tab: "tb-1",
    },
    ...overrides,
  });
}

test("start creates a normalized immutable review request with a frozen target", () => {
  const request = makeRequest({
    id: "rv-1",
    createdAt: "2026-11-17T04:00:00.000Z",
    repo: {
      root: "/work/repo/",
      machine: null,
      head: "abc123",
      fingerprint: "fp-1",
    },
    files: [
      { path: "src\\b.ts", status: "M" },
      { path: "src/a.ts", status: "??" },
    ],
    target: {
      address: "t7",
      app: "traecli",
      title: "Fix login",
      space: "sp-1",
      tab: "tb-1",
    },
  });

  assert.deepEqual(request, {
    schema: "herdr.emacs-review/request@1",
    id: "rv-1",
    createdAt: "2026-11-17T04:00:00.000Z",
    repo: {
      root: "/work/repo",
      machine: null,
      head: "abc123",
      fingerprint: "fp-1",
    },
    scope: {
      kind: "worktree",
      files: [
        { path: "src/b.ts", status: "M" },
        { path: "src/a.ts", status: "A" },
      ],
    },
    target: {
      address: "t7",
      app: "traecli",
      title: "Fix login",
      space: "sp-1",
      tab: "tb-1",
    },
  });
  assert.ok(Object.isFrozen(request));
  assert.ok(Object.isFrozen(request.repo));
  assert.ok(Object.isFrozen(request.scope.files));
  assert.ok(Object.isFrozen(request.target));
});

test("finish accepts scoped findings and formats one stable feedback message", () => {
  const accepted = acceptResult(requestFixture(), {
    schema: "herdr.emacs-review/result@1",
    sessionId: "rv-1",
    finishedAt: "2026-11-17T04:10:00.000Z",
    snapshot: { head: "abc123", fingerprint: "fp-1" },
    summary: "Review completed in Emacs",
    findings: [
      {
        id: "f-1",
        path: "src/b.ts",
        side: "new",
        startLine: 42,
        endLine: 44,
        severity: "required",
        hunk: "@@ -38,6 +38,9 @@",
        anchor: {
          before: ["const input = value;"],
          line: "const result = transform(input);",
          after: ["return result;"],
        },
        message: "Handle the null case and add a regression test.",
      },
    ],
  });

  assert.equal(accepted.state, "ready");
  assert.equal(accepted.result.findings[0].path, "src/b.ts");
  assert.equal(
    accepted.feedback,
    `[HERDR REVIEW rv-1]\n` +
      `Repo: /work/repo\n` +
      `Snapshot: HEAD abc123, fingerprint fp-1\n` +
      `Findings: 1\n\n` +
      `1. [required] src/b.ts:new:42-44\n` +
      `   Hunk: @@ -38,6 +38,9 @@\n` +
      `   Anchor: const result = transform(input);\n` +
      `   Remark: Handle the null case and add a regression test.\n\n` +
      `Please address every required finding, report what changed, and explain any finding you disagree with.`,
  );
});

test("finish accepts the Emacs severity vocabulary and rejects legacy advisory", () => {
  for (const severity of ["required", "suggestion", "note"]) {
    const accepted = acceptResult(requestFixture(), {
      schema: "herdr.emacs-review/result@1",
      sessionId: "rv-1",
      finishedAt: "2026-11-17T04:10:00.000Z",
      snapshot: { head: "abc123", fingerprint: "fp-1" },
      findings: [{
        id: `f-${severity}`,
        path: "src/b.ts",
        side: "new",
        startLine: 42,
        endLine: 42,
        severity,
        message: `${severity} finding`,
      }],
    });
    assert.equal(accepted.result.findings[0].severity, severity);
    assert.match(accepted.feedback, new RegExp(`\\[${severity}\\]`));
  }

  assert.throws(
    () => acceptResult(requestFixture(), {
      schema: "herdr.emacs-review/result@1",
      sessionId: "rv-1",
      finishedAt: "2026-11-17T04:10:00.000Z",
      snapshot: { head: "abc123", fingerprint: "fp-1" },
      findings: [{
        id: "f-advisory",
        path: "src/b.ts",
        side: "new",
        startLine: 42,
        severity: "advisory",
        message: "legacy finding",
      }],
    }),
    /finding\.severity is invalid/,
  );
});

test("finish becomes stale when Herdr observes a newer worktree snapshot", () => {
  const accepted = acceptResult(
    requestFixture(),
    {
      schema: "herdr.emacs-review/result@1",
      sessionId: "rv-1",
      finishedAt: "2026-11-17T04:10:00.000Z",
      snapshot: { head: "abc123", fingerprint: "fp-1" },
      findings: [],
    },
    { head: "abc123", fingerprint: "fp-new" },
  );

  assert.equal(accepted.state, "stale_ready");
});

test("a finished review waits durably while its frozen target is working", () => {
  const next = advanceSession(
    { id: "rv-1", state: "ready", target: { address: "t7" } },
    { type: "target_observed", status: "working" },
  );

  assert.deepEqual(next, {
    id: "rv-1",
    state: "waiting_idle",
    target: { address: "t7" },
    delivery: { condition: "idle", lastStatus: "working" },
  });
});

test("an idle frozen target yields a conditional send attempt", () => {
  const next = advanceSession(
    { id: "rv-1", state: "waiting_idle", target: { address: "t7" } },
    { type: "target_observed", status: "idle" },
  );

  assert.deepEqual(next, {
    id: "rv-1",
    state: "sending",
    target: { address: "t7" },
    delivery: { condition: "idle", lastStatus: "idle" },
  });
});

test("a blocked target preserves the finished review without forcing input", () => {
  const next = advanceSession(
    { id: "rv-1", state: "ready", target: { address: "t7" } },
    { type: "target_observed", status: "blocked" },
  );

  assert.deepEqual(next, {
    id: "rv-1",
    state: "delivery_blocked",
    target: { address: "t7" },
    delivery: { condition: "idle", lastStatus: "blocked" },
  });
});

test("a preserved blocked review resumes when the same target becomes idle", () => {
  const next = advanceSession(
    {
      id: "rv-1",
      state: "delivery_blocked",
      target: { address: "t7" },
      delivery: { condition: "idle", lastStatus: "blocked" },
    },
    { type: "target_observed", status: "idle" },
  );

  assert.equal(next.state, "sending");
  assert.deepEqual(next.delivery, { condition: "idle", lastStatus: "idle" });
});

test("a preserved blocked review waits if the same target starts working", () => {
  const next = advanceSession(
    {
      id: "rv-1",
      state: "delivery_blocked",
      target: { address: "t7" },
      delivery: { condition: "idle", lastStatus: "blocked" },
    },
    { type: "target_observed", status: "working" },
  );

  assert.equal(next.state, "waiting_idle");
  assert.deepEqual(next.delivery, { condition: "idle", lastStatus: "working" });
});

test("only a structured core turn marks a sending review as sent", () => {
  const next = advanceSession(
    {
      id: "rv-1",
      state: "sending",
      target: { address: "t7" },
      delivery: { condition: "idle", lastStatus: "idle" },
    },
    { type: "send_succeeded", turn: 12, status: "idle" },
  );

  assert.deepEqual(next, {
    id: "rv-1",
    state: "sent",
    target: { address: "t7" },
    delivery: {
      condition: "idle",
      lastStatus: "idle",
      turn: 12,
      acceptedStatus: "idle",
    },
  });
});

test("Emacs launch expression transports a Unicode request path without shell quoting", () => {
  assert.equal(
    emacsOpenExpression("/Users/me/评审/rv-1/request.json"),
    '(hc-review-open-session-from-base64 "L1VzZXJzL21lL+ivhOWuoS9ydi0xL3JlcXVlc3QuanNvbg==")',
  );
});

test("decoupled Emacs start transports project and target hint without a Herdr session", () => {
  const expression = emacsStartProjectExpression({
    root: "/Users/me/评审 repo",
    target: { address: "t7", title: "Fix login" },
  });
  const encoded = expression.match(/"([A-Za-z0-9+/=]+)"/)[1];
  const intent = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));

  assert.equal(expression.startsWith("(hc-review-start-project-from-base64 "), true);
  assert.deepEqual(intent, {
    schema: "hc-review/start@1",
    root: "/Users/me/评审 repo",
    target: { address: "t7", title: "Fix login" },
  });
  assert.equal(Object.hasOwn(intent, "requestPath"), false);
  assert.equal(Object.hasOwn(intent, "sessionId"), false);
});

test("decoupled Emacs start does not require a Herdr target", () => {
  const expression = emacsStartProjectExpression({ root: "/Users/me/repo" });
  const encoded = expression.match(/"([A-Za-z0-9+/=]+)"/)[1];
  const intent = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));

  assert.deepEqual(intent, {
    schema: "hc-review/start@1",
    root: "/Users/me/repo",
    target: null,
  });
});

test("cancel accepts only the matching versioned review session", () => {
  const request = requestFixture();
  assert.deepEqual(
    acceptCancel(request, {
      schema: "herdr.emacs-review/cancel@1",
      sessionId: "rv-1",
      cancelledAt: "2026-11-17T04:11:00.000Z",
    }),
    {
      schema: "herdr.emacs-review/cancel@1",
      sessionId: "rv-1",
      cancelledAt: "2026-11-17T04:11:00.000Z",
    },
  );
  assert.throws(
    () => acceptCancel(request, {
      schema: "herdr.emacs-review/cancel@1",
      sessionId: "rv-other",
      cancelledAt: "2026-11-17T04:11:00.000Z",
    }),
    /another review session/,
  );
});
