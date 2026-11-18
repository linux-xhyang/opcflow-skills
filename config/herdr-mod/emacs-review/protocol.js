export const REQUEST_SCHEMA = "herdr.emacs-review/request@1";
export const RESULT_SCHEMA = "herdr.emacs-review/result@1";
export const CANCEL_SCHEMA = "herdr.emacs-review/cancel@1";
export const FINDING_SEVERITIES = Object.freeze(["required", "suggestion", "note"]);

const STATUS = new Map([
  ["??", "A"],
  ["A", "A"],
  ["M", "M"],
  ["D", "D"],
  ["U", "U"],
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeRoot(root) {
  invariant(typeof root === "string" && root.length > 0, "repo.root is required");
  const normalized = root.replace(/\\/g, "/").replace(/\/+$/, "");
  invariant(normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized), "repo.root must be absolute");
  return normalized;
}

function normalizePath(path) {
  invariant(typeof path === "string" && path.length > 0, "file path is required");
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  invariant(!normalized.startsWith("/") && !/^[A-Za-z]:\//.test(normalized), "file path must be relative");
  invariant(!normalized.split("/").includes(".."), "file path may not escape the repo");
  return normalized;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function text(value, name, { required = false, max = 4000 } = {}) {
  invariant(value === null || value === undefined || typeof value === "string", `${name} must be text`);
  const normalized = String(value ?? "").trim();
  invariant(!required || normalized.length > 0, `${name} is required`);
  invariant(normalized.length <= max, `${name} is too long`);
  return normalized;
}

function positiveLine(value, name, required) {
  if (value === null || value === undefined) {
    invariant(!required, `${name} is required`);
    return null;
  }
  invariant(Number.isInteger(value) && value > 0, `${name} must be a positive integer`);
  return value;
}

function anchorLines(value, name) {
  invariant(value === undefined || Array.isArray(value), `${name} must be a list`);
  const lines = value ?? [];
  invariant(lines.length <= 3, `${name} may contain at most three lines`);
  return lines.map((line) => text(line, name, { max: 1000 }));
}

export function makeRequest({ id, createdAt, repo, files, target }) {
  invariant(typeof id === "string" && id.length > 0, "review id is required");
  invariant(typeof createdAt === "string" && !Number.isNaN(Date.parse(createdAt)), "createdAt must be an ISO date");
  invariant(repo && typeof repo === "object", "repo is required");
  invariant(Array.isArray(files) && files.length > 0, "at least one changed file is required");
  invariant(target && typeof target === "object", "target is required");
  invariant(typeof target.address === "string" && target.address.length > 0, "target.address is required");

  const request = {
    schema: REQUEST_SCHEMA,
    id,
    createdAt,
    repo: {
      root: normalizeRoot(repo.root),
      machine: repo.machine ?? null,
      head: repo.head ?? null,
      fingerprint: String(repo.fingerprint ?? ""),
    },
    scope: {
      kind: "worktree",
      files: files.map(({ path, status }) => ({
        path: normalizePath(path),
        status: STATUS.get(status) ?? STATUS.get(String(status).slice(0, 1)) ?? "M",
      })),
    },
    target: {
      address: target.address,
      app: target.app ?? null,
      title: target.title ?? "",
      space: target.space ?? "",
      tab: target.tab ?? "",
    },
  };
  return deepFreeze(request);
}

function normalizeFinding(finding, scopedPaths) {
  invariant(finding && typeof finding === "object", "finding must be an object");
  const id = text(finding.id, "finding.id", { required: true, max: 200 });
  const path = normalizePath(finding.path);
  invariant(scopedPaths.has(path), `finding path is outside review scope: ${path}`);
  invariant(["old", "new", "file"].includes(finding.side), "finding.side is invalid");
  invariant(FINDING_SEVERITIES.includes(finding.severity), "finding.severity is invalid");
  const startLine = positiveLine(finding.startLine, "finding.startLine", finding.side !== "file");
  const endLine = positiveLine(finding.endLine, "finding.endLine", false) ?? startLine;
  invariant(startLine === null || endLine >= startLine, "finding.endLine precedes startLine");
  const anchor = finding.anchor ?? {};
  invariant(anchor && typeof anchor === "object" && !Array.isArray(anchor), "finding.anchor must be an object");
  return {
    id,
    path,
    side: finding.side,
    startLine,
    endLine,
    severity: finding.severity,
    hunk: text(finding.hunk, "finding.hunk", { max: 2000 }),
    anchor: {
      before: anchorLines(anchor.before, "finding.anchor.before"),
      line: text(anchor.line, "finding.anchor.line", { max: 2000 }),
      after: anchorLines(anchor.after, "finding.anchor.after"),
    },
    message: text(finding.message, "finding.message", { required: true, max: 4000 }),
  };
}

function formatLocation(finding) {
  if (finding.side === "file") return `${finding.path}:file`;
  const range = finding.endLine === finding.startLine
    ? String(finding.startLine)
    : `${finding.startLine}-${finding.endLine}`;
  return `${finding.path}:${finding.side}:${range}`;
}

function indentRemark(message) {
  return message.replace(/\n/g, "\n   ");
}

function feedbackFor(request, findings) {
  const head = request.repo.head ?? "unborn";
  const body = findings.map((finding, index) => {
    const lines = [`${index + 1}. [${finding.severity}] ${formatLocation(finding)}`];
    if (finding.hunk) lines.push(`   Hunk: ${finding.hunk}`);
    if (finding.anchor.line) lines.push(`   Anchor: ${finding.anchor.line}`);
    lines.push(`   Remark: ${indentRemark(finding.message)}`);
    return lines.join("\n");
  }).join("\n\n");
  return [
    `[HERDR REVIEW ${request.id}]`,
    `Repo: ${request.repo.root}`,
    `Snapshot: HEAD ${head}, fingerprint ${request.repo.fingerprint}`,
    `Findings: ${findings.length}`,
    "",
    body,
    "",
    "Please address every required finding, report what changed, and explain any finding you disagree with.",
  ].join("\n");
}

export function acceptResult(request, candidate, observedSnapshot = null) {
  invariant(request?.schema === REQUEST_SCHEMA, "request schema is invalid");
  invariant(candidate && typeof candidate === "object", "result must be an object");
  invariant(JSON.stringify(candidate).length <= 128 * 1024, "result is too large");
  invariant(candidate.schema === RESULT_SCHEMA, "result schema is invalid");
  invariant(candidate.sessionId === request.id, "result belongs to another review session");
  invariant(typeof candidate.finishedAt === "string" && !Number.isNaN(Date.parse(candidate.finishedAt)), "finishedAt must be an ISO date");
  invariant(candidate.snapshot && typeof candidate.snapshot === "object", "result snapshot is required");
  invariant(Array.isArray(candidate.findings), "result findings must be a list");
  invariant(candidate.findings.length <= 500, "result has too many findings");
  const scopedPaths = new Set(request.scope.files.map((file) => file.path));
  const findings = candidate.findings.map((finding) => normalizeFinding(finding, scopedPaths));
  const ids = new Set(findings.map((finding) => finding.id));
  invariant(ids.size === findings.length, "result contains duplicate finding ids");
  const result = deepFreeze({
    schema: RESULT_SCHEMA,
    sessionId: request.id,
    finishedAt: candidate.finishedAt,
    snapshot: {
      head: candidate.snapshot.head ?? null,
      fingerprint: String(candidate.snapshot.fingerprint ?? ""),
    },
    summary: text(candidate.summary, "result.summary", { max: 4000 }),
    findings,
  });
  const observed = observedSnapshot ?? result.snapshot;
  const stale = result.snapshot.head !== request.repo.head
    || result.snapshot.fingerprint !== request.repo.fingerprint
    || observed.head !== request.repo.head
    || observed.fingerprint !== request.repo.fingerprint;
  return deepFreeze({
    state: stale ? "stale_ready" : "ready",
    result,
    feedback: feedbackFor(request, findings),
  });
}

export function acceptCancel(request, candidate) {
  invariant(request?.schema === REQUEST_SCHEMA, "request schema is invalid");
  invariant(candidate && typeof candidate === "object", "cancel must be an object");
  invariant(candidate.schema === CANCEL_SCHEMA, "cancel schema is invalid");
  invariant(candidate.sessionId === request.id, "cancel belongs to another review session");
  invariant(typeof candidate.cancelledAt === "string" && !Number.isNaN(Date.parse(candidate.cancelledAt)), "cancelledAt must be an ISO date");
  return deepFreeze({
    schema: CANCEL_SCHEMA,
    sessionId: request.id,
    cancelledAt: candidate.cancelledAt,
  });
}

export function advanceSession(session, event) {
  invariant(session && typeof session === "object", "session is required");
  invariant(event && typeof event === "object", "session event is required");
  if (event.type === "target_observed"
      && event.status === "working"
      && ["ready", "waiting_idle", "delivery_blocked"].includes(session.state)) {
    return deepFreeze({
      ...session,
      state: "waiting_idle",
      delivery: { condition: "idle", lastStatus: "working" },
    });
  }
  if (event.type === "target_observed"
      && event.status === "idle"
      && ["ready", "waiting_idle", "delivery_blocked"].includes(session.state)) {
    return deepFreeze({
      ...session,
      state: "sending",
      delivery: { condition: "idle", lastStatus: "idle" },
    });
  }
  if (event.type === "target_observed"
      && event.status === "blocked"
      && ["ready", "waiting_idle", "delivery_blocked"].includes(session.state)) {
    return deepFreeze({
      ...session,
      state: "delivery_blocked",
      delivery: { condition: "idle", lastStatus: "blocked" },
    });
  }
  if (event.type === "send_succeeded" && session.state === "sending") {
    invariant(Number.isInteger(event.turn) && event.turn >= 0, "send result has no core turn");
    return deepFreeze({
      ...session,
      state: "sent",
      delivery: {
        ...(session.delivery ?? {}),
        turn: event.turn,
        acceptedStatus: event.status ?? null,
      },
    });
  }
  throw new Error(`invalid review transition: ${session.state} + ${event.type}`);
}

export function emacsOpenExpression(requestPath) {
  invariant(typeof requestPath === "string" && requestPath.length > 0, "request path is required");
  return `(hc-review-open-session-from-base64 "${base64Utf8(requestPath)}")`;
}

function base64Utf8(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function emacsStartProjectExpression({ root, target = null }) {
  const normalizedRoot = normalizeRoot(root);
  if (target !== null) {
    invariant(target && typeof target === "object", "target hint must be an object");
    invariant(typeof target.address === "string" && target.address.length > 0, "target hint address is required");
  }
  const intent = {
    schema: "hc-review/start@1",
    root: normalizedRoot,
    target: target === null ? null : {
      address: target.address,
      title: target.title ?? "",
    },
  };
  return `(hc-review-start-project-from-base64 "${base64Utf8(JSON.stringify(intent))}")`;
}
