import * as fs from "fs/promises";

import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import {
  agents,
  appHome,
  checking,
  exec,
  focused,
  hc,
  panes,
  readTextFile,
  spaces,
  theme,
  writeTextFile,
} from "herdr";

import {
  acceptCancel,
  acceptResult,
  advanceSession,
  emacsStartProjectExpression,
} from "./protocol.js";
import { worktreeFingerprintMaterial } from "./snapshot.js";

const STATE_SCHEMA = "herdr.emacs-review/state@1";
const POLL_MS = 1500;

function contextNow() {
  const space = spaces().find((candidate) => candidate.active);
  const f = focused();
  const pane = f?.pane ? panes().find((candidate) => candidate.pane === f.pane) : null;
  const on = f?.pane === null
    ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null)
    : space?.machine ?? null;
  return {
    cwd: pane?.cwd || f?.cwd || space?.folder || null,
    on,
    space: space?.id ?? null,
    tab: f?.tab ?? space?.tabs?.find((tab) => tab.active)?.id ?? null,
    focusedAgent: f?.agent ?? f?.terminal ?? null,
  };
}

function contextKey(context) {
  return JSON.stringify({
    cwd: context.cwd,
    on: context.on,
    space: context.space,
    tab: context.tab,
  });
}

function fingerprint(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function statusFromXY(xy) {
  if (xy === "??" || xy.includes("A")) return "A";
  if (xy.includes("U") || xy === "AA" || xy === "DD") return "U";
  if (xy.includes("D")) return "D";
  return "M";
}

function changedFiles(statusOutput) {
  return statusOutput.split("\0").filter(Boolean).map((entry) => ({
    path: entry.slice(3),
    status: statusFromXY(entry.slice(0, 2)),
  })).slice(0, 1000);
}

async function readJson(path) {
  const source = await readTextFile(path);
  return source === null ? null : JSON.parse(source);
}

async function replaceJson(path, value) {
  const previous = await readTextFile(path);
  const next = `${JSON.stringify(value, null, 2)}\n`;
  await writeTextFile(path, next, previous);
}

function messageFromError(error) {
  return error instanceof Error ? error.message : String(error);
}

function stateLabel(state) {
  return ({
    created: "Creating review…",
    reviewing: "Reviewing in Emacs",
    ready: "Review finished",
    stale_ready: "Review finished · diff changed",
    waiting_idle: "Waiting for agent to become idle",
    sending: "Sending review…",
    sent: "Review sent",
    cancelled: "Review cancelled",
    failed_start: "Could not start Emacs review",
    invalid_result: "Emacs returned an invalid review",
    delivery_blocked: "Agent needs attention",
    delivery_failed: "Review delivery failed",
    unknown_delivery: "Delivery result is unknown",
  })[state] ?? state;
}

export default class EmacsReview extends View {
  init(_props, cx) {
    this.context = contextNow();
    this.contextKey = contextKey(this.context);
    this.selectedTarget = null;
    this.session = null;
    this.busy = false;
    this.polling = false;
    this.error = null;
    this.notice = null;
    this.syncCandidates();
    if (!checking()) {
      cx.spawn(async (cx) => {
        await this.restoreLatest();
        cx.notify();
      });
      cx.timer.every(POLL_MS, (cx) => this.scheduleTick(cx));
    }
  }

  get root() {
    return `${appHome()}/review-sessions`;
  }

  sessionDir(id) {
    return `${this.root}/${id}`;
  }

  syncContext() {
    const next = contextNow(), key = contextKey(next);
    if (key === this.contextKey) return false;
    this.context = next;
    this.contextKey = key;
    this.syncCandidates();
    return true;
  }

  syncCandidates() {
    const { space, tab, focusedAgent } = this.context;
    this.candidates = agents().filter((agent) => agent.space === space && agent.tab === tab);
    const stillPresent = this.candidates.some((agent) => agent.address === this.selectedTarget);
    if (stillPresent) return;
    const focusedCandidate = this.candidates.find((agent) => agent.address === focusedAgent);
    this.selectedTarget = focusedCandidate?.address
      ?? (this.candidates.length === 1 ? this.candidates[0].address : null);
  }

  target() {
    return this.candidates.find((agent) => agent.address === this.selectedTarget) ?? null;
  }

  async gitRoot(cwd = this.context.cwd, on = this.context.on) {
    if (on) throw new Error("Remote Emacs review is not supported yet");
    if (!cwd) throw new Error("No project folder is focused");
    const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
    if (top.code !== 0) throw new Error("The focused folder is not a Git repository");
    return top.stdout.trim();
  }

  async gitSnapshot(cwd = this.context.cwd, on = this.context.on, requireChanges = true) {
    const root = await this.gitRoot(cwd, on);
    const status = await exec("git", [
      "--no-optional-locks",
      "-c", "core.fsmonitor=false",
      "-c", "diff.autoRefreshIndex=false",
      "status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=all",
    ], { cwd: root, on });
    if (status.code !== 0) throw new Error(status.stderr || "Cannot read Git status");
    const files = changedFiles(status.stdout);
    if (requireChanges && !files.length) throw new Error("There are no changed files to review");
    const headResult = await exec("git", ["rev-parse", "--verify", "HEAD"], { cwd: root, on });
    const head = headResult.code === 0 ? headResult.stdout.trim() : null;
    const worktreeHashes = await worktreeFingerprintMaterial({
      root,
      files,
      hashFiles: async (paths) => {
        const hashes = await exec("git", ["hash-object", "--no-filters", "--", ...paths], { cwd: root, on });
        if (hashes.code !== 0) throw new Error(hashes.stderr || "Cannot fingerprint changed files");
        return hashes.stdout;
      },
    });
    return {
      root,
      head,
      files,
      fingerprint: fingerprint(`${head ?? "unborn"}\0${status.stdout}\0${worktreeHashes}`),
    };
  }

  async saveSession(next) {
    const statePath = `${this.sessionDir(next.id)}/state.json`;
    const value = { ...next, schema: STATE_SCHEMA, updatedAt: new Date().toISOString() };
    await replaceJson(statePath, value);
    this.session = value;
  }

  async restoreLatest() {
    let entries;
    try { entries = await fs.readdir(this.root, { withFileTypes: true }); }
    catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    const states = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const state = await readJson(`${this.root}/${entry.name}/state.json`);
        if (state?.schema === STATE_SCHEMA) states.push(state);
      } catch { /* A partial or foreign directory is not a Review Session. */ }
    }
    states.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
    const restored = states.find((state) => !["sent", "cancelled"].includes(state.state)) ?? states[0];
    if (!restored) return;
    if (restored.state === "sending") {
      await this.saveSession({
        ...restored,
        state: "unknown_delivery",
        error: "Herdr restarted while delivery was in flight; review before retrying",
      });
    } else {
      this.session = restored;
    }
  }

  start(cx) {
    const target = this.target();
    if (this.busy || this.context.on) return;
    this.busy = true;
    this.error = null;
    this.notice = null;
    const capturedContext = { ...this.context };
    cx.spawn(async (cx) => {
      try {
        const root = await this.gitRoot(capturedContext.cwd, capturedContext.on);
        if (contextKey(capturedContext) !== this.contextKey) throw new Error("Project context changed before review started");
        const launched = await exec("emacsclient", [
          "--no-wait",
          "--eval",
          emacsStartProjectExpression({
            root,
            target: target ? {
              address: target.address,
              title: target.title,
            } : null,
          }),
        ], { cwd: root, timeout: 10000 });
        if (launched.code !== 0) throw new Error(launched.stderr.trim() || `emacsclient exited ${launched.code}`);
        this.notice = target
          ? `Opened in Emacs · target hint ${target.address}`
          : "Opened in Emacs · choose target when finishing";
      } catch (error) {
        const detail = messageFromError(error);
        this.error = detail;
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  scheduleTick(cx) {
    this.syncContext();
    this.syncCandidates();
    if (this.polling || !this.session) { cx.notify(); return; }
    this.polling = true;
    cx.spawn(async (cx) => {
      try { await this.tick(); }
      catch (error) { this.error = messageFromError(error); }
      finally { this.polling = false; cx.notify(); }
    });
  }

  async tick() {
    if (["created", "reviewing"].includes(this.session.state)) {
      const dir = this.sessionDir(this.session.id);
      const cancelled = await readJson(`${dir}/cancel.json`);
      if (cancelled) {
        try {
          acceptCancel(this.session.request, cancelled);
          await this.saveSession({ ...this.session, state: "cancelled", error: null });
        } catch (error) {
          await this.saveSession({
            ...this.session,
            state: "invalid_result",
            error: messageFromError(error),
          });
        }
        return;
      }
      const candidate = await readJson(`${dir}/result.json`);
      if (candidate) {
        try {
          const observed = await this.gitSnapshot(
            this.session.request.repo.root,
            this.session.request.repo.machine,
            false,
          );
          const accepted = acceptResult(this.session.request, candidate, observed);
          await this.saveSession({
            ...this.session,
            state: accepted.state,
            result: accepted.result,
            feedback: accepted.feedback,
            error: null,
          });
        } catch (error) {
          await this.saveSession({
            ...this.session,
            state: "invalid_result",
            error: messageFromError(error),
          });
          return;
        }
      }
    }
    if (["ready", "waiting_idle", "delivery_blocked"].includes(this.session.state)) {
      await this.reconcileDelivery();
    }
  }

  async reconcileDelivery() {
    const target = agents().find((agent) => agent.address === this.session.request.target.address);
    if (!target) {
      await this.saveSession({
        ...this.session,
        state: "delivery_failed",
        error: "The selected coding agent is no longer live",
      });
      return;
    }
    if (!["idle", "working", "blocked"].includes(target.status)) {
      await this.saveSession({
        ...this.session,
        state: "delivery_failed",
        error: `The selected coding agent is ${target.status ?? "unavailable"}`,
      });
      return;
    }
    const next = advanceSession(this.session, { type: "target_observed", status: target.status });
    const unchanged = next.state === this.session.state
      && JSON.stringify(next.delivery ?? null) === JSON.stringify(this.session.delivery ?? null);
    if (!unchanged) await this.saveSession(next);
    if (next.state === "sending") await this.deliver();
  }

  async deliver() {
    const { address } = this.session.request.target;
    const result = await hc(["send", "--json", "--if", "idle", address, this.session.feedback]);
    if (result.code !== 0) {
      await this.saveSession({
        ...this.session,
        state: "delivery_failed",
        error: (result.stderr || result.stdout || `hc send exited ${result.code}`).trim(),
      });
      return;
    }
    let sent;
    try { sent = JSON.parse(result.stdout); }
    catch { throw new Error("hc send returned invalid JSON"); }
    const next = advanceSession(this.session, {
      type: "send_succeeded",
      turn: sent.turn,
      status: sent.status,
    });
    await this.saveSession(next);
  }

  retry(cx) {
    if (!this.session || this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        await this.saveSession({ ...this.session, state: "ready", error: null });
        await this.reconcileDelivery();
      } catch (error) { this.error = messageFromError(error); }
      finally { this.busy = false; cx.notify(); }
    });
  }

  render(cx) {
    this.syncContext();
    this.syncCandidates();
    const t = theme(), target = this.target(), state = this.session?.state;
    const canStart = Boolean(this.context.cwd && !this.context.on && !this.busy);
    const canRetry = ["stale_ready", "delivery_blocked", "delivery_failed", "unknown_delivery"].includes(state) && !this.busy;
    return v_flex().id("emacs-review").h_full().min_h(0).px(10).py(8).gap(6).bg(t.background).border_b(1).border_color(t.border).text_color(t.foreground).text_size(12)
      .child(h_flex().gap(8).items_center()
        .child(div().font_semibold().child("Emacs Review"))
        .child(div().flex_1())
        .child(div().text_size(10).text_color(this.context.on ? t.ansi1 : t.dim).child(this.context.on ? "Local only" : `${this.candidates.length} agent${this.candidates.length === 1 ? "" : "s"}`)))
      .child(h_flex().gap(5).items_center().children(this.candidates.map((agent) => div()
        .id(`review-target-${agent.address}`).max_w(150).px(6).py(3).rounded(5).truncate().cursor_pointer()
        .bg(agent.address === this.selectedTarget ? t.selected : t.raised)
        .text_color(agent.status === "blocked" ? t.blocked : agent.address === this.selectedTarget ? t.foreground : t.muted)
        .on_click((_event, cx) => { this.selectedTarget = agent.address; cx.notify(); })
        .child(`${agent.address} · ${agent.status}`)))
        .when(!this.candidates.length, (element) => element.child(div().text_color(t.dim).child("No target hint · choose in Emacs"))))
      .child(h_flex().gap(8).items_center()
        .child(div().flex_1().min_w(0).truncate().text_color(this.error || this.session?.error ? t.ansi1 : t.dim)
          .child(this.error || this.session?.error || this.notice || (state ? stateLabel(state) : "Review changed files in project buffers with diff-hl")))
        .when(canRetry, (element) => element.child(div().id("review-retry").px(8).py(4).rounded(6).cursor_pointer().bg(t.raised).hover((item) => item.bg(t.hover)).on_click((_event, cx) => this.retry(cx)).child("Retry send")))
        .child(div().id("review-start").px(9).py(4).rounded(6).bg(canStart ? t.solid : t.raised).text_color(canStart ? t.solid_foreground : t.dim)
          .when(canStart, (element) => element.cursor_pointer().hover((item) => item.bg(t.accent)).on_click((_event, cx) => this.start(cx)))
          .child(this.busy ? "Opening…" : "Open Review")));
  }
}
