// Sessions: herdr-app 会话历史列表 panel mod。
//
// 列出各 agent CLI（TraeX / Claude Code / Codex / Grok / Cursor / pi）的会话历史：
//   - 搜索（标题 / 项目路径）、按 CLI 过滤
//   - 当前 tab 的会话高亮（读 hc 终端的 herdr-mobile-relay.session 标签）
//   - 恢复：在新 tab 里跑对应 CLI 的 resume 命令
//   - 打开会话所在项目目录（macOS: open，Linux: xdg-open）
//
// 数据来源: scan.py（TRAE 使用 thread/list，其余 CLI 扫描会话日志）。
// 打开方式: pane.split {"direction": "right", "mod": "sessions"}
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Textarea, TextareaState } from "gpui-base";
import { theme, exec, run, spaces, panes, focused, agents, appHome, readTextFile, window } from "herdr";

// 各 CLI 的显示名与恢复命令；没有 resume 的（cursor/pi）只提供打开目录
const CLI_META = {
  traex: { label: "TraeX", resume: (id) => ["traecli", "resume", id] },
  claude: { label: "Claude", resume: (id) => ["claude", "--resume", id] },
  codex: { label: "Codex", resume: (id) => ["codex", "resume", id] },
  grok: { label: "Grok", resume: (id) => ["grok", "resume", id] },
  cursor: { label: "Cursor" },
  pi: { label: "pi" },
};
// OSC 7501 app 名 → 我们的 cli 键
const APP_TO_CLI = {
  traecli: "traex",
  traex: "traex",
  "traex-tui": "traex",
  "claude-code": "claude",
  codex: "codex",
  grok: "grok",
  cursor: "cursor",
  pi: "pi",
};
const CLIS = ["traex", "claude", "codex", "grok", "cursor", "pi"];
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
// A remote Herdr core runs programs on its own host but does not receive this
// app's mod files.  Read scan.py locally and execute its exact UTF-8 source in
// the remote Python process, with its normal command-line arguments restored.
const REMOTE_SCANNER_BOOTSTRAP = "import base64,sys;source,*args=sys.argv[1:];sys.argv=['scan.py',*args];exec(compile(base64.b64decode(source).decode('utf-8'),'<herdr-sessions-scan>','exec'))";

function base64Utf8(value) {
  // gpui-shell deliberately exposes only ES2022 byte primitives. scan.py is
  // UTF-8 source, so encode it directly before passing it as one argv string.
  const bytes = [];
  for (let index = 0; index < value.length; index += 1) {
    const codepoint = value.codePointAt(index);
    if (codepoint > 0xffff) index += 1;
    if (codepoint <= 0x7f) bytes.push(codepoint);
    else if (codepoint <= 0x7ff) bytes.push(0xc0 | (codepoint >> 6), 0x80 | (codepoint & 0x3f));
    else if (codepoint <= 0xffff) bytes.push(0xe0 | (codepoint >> 12), 0x80 | ((codepoint >> 6) & 0x3f), 0x80 | (codepoint & 0x3f));
    else bytes.push(0xf0 | (codepoint >> 18), 0x80 | ((codepoint >> 12) & 0x3f), 0x80 | ((codepoint >> 6) & 0x3f), 0x80 | (codepoint & 0x3f));
  }
  let encoded = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const left = bytes[index];
    const middle = bytes[index + 1];
    const right = bytes[index + 2];
    encoded += BASE64[left >> 2];
    encoded += BASE64[((left & 0x03) << 4) | ((middle ?? 0) >> 4)];
    encoded += middle === undefined ? "=" : BASE64[((middle & 0x0f) << 2) | ((right ?? 0) >> 6)];
    encoded += right === undefined ? "=" : BASE64[right & 0x3f];
  }
  return encoded;
}

function normalizePath(path) {
  return (path || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function sessionKey(session) {
  return `${session.machine ?? "local"}:${session.cli}:${session.id}`;
}

function activeSpaceContext() {
  const space = spaces().find((s) => s.active);
  if (!space) return { id: null, name: "当前 Space", machine: null, roots: [] };
  const tabs = new Set((space.tabs ?? []).map((tab) => tab.id));
  const paneRoots = panes()
    .filter((pane) => tabs.has(pane.tab) && pane.cwd)
    .map((pane) => normalizePath(pane.cwd));
  // live pane 的 cwd 比 space 创建时的 folder 更准确；后者可能只是 $HOME。
  const candidates = paneRoots.length ? paneRoots : [normalizePath(space.folder)];
  const roots = [...new Set(candidates.filter(Boolean))].filter(
    (path, _index, all) => !all.some((other) => other !== path && path.startsWith(other + "/")),
  );
  return { id: space.id, name: space.name || "当前 Space", machine: space.machine ?? null, roots };
}

function inSpace(session, context) {
  if ((session.machine ?? null) !== context.machine) return false;
  // A remote space may not expose its cwd until one of its panes is shown.
  // In that case "current Space" safely means all sessions on that host,
  // rather than silently showing an empty local-looking list.
  if (!context.roots.length) return true;
  const cwd = normalizePath(session.cwd);
  return Boolean(cwd && context.roots.some((root) => cwd === root || cwd.startsWith(root + "/")));
}

function fmtTime(sec) {
  if (!sec) return "";
  const d = new Date(sec * 1000);
  const now = new Date();
  const days = Math.floor((now - d) / 86400000);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  if (days <= 0) return hm;
  if (days === 1) return "昨天 " + hm;
  if (days < 7) return `${days} 天前`;
  if (d.getFullYear() === now.getFullYear()) return md;
  return `${d.getFullYear()}/${md}`;
}

export default class Sessions extends View {
  init(_props, cx) {
    this.query = TextareaState.new({ placeholder: "搜索标题 / 项目路径", rows: 1 });
    this.query.on("change", (_e, cx) => cx.notify());
    this.uid = `sessions-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    this.cli = "all";
    this.scope = "space";
    this.sessions = [];
    this.loading = false;
    this.error = null;
    this.pendingDelete = null;
    this.actionKey = null;
    this.actionError = null;
    this.showArchived = false;
    this.scanGeneration = 0;
    this.refreshPending = false;
    this.activeScan = null;
    this.currentKey = null; // `${cli}:${id}` 当前 tab 的会话
    this.contextKey = null;
    this.remoteScanner = null;
    this.updated = 0;
    this.refresh(cx);
    this.refreshCurrent(cx);
    cx.timer.every(10000, (cx) => {
      this.refresh(cx);
      this.refreshCurrent(cx);
    });
    // 弹窗挂载的首帧布局可能不完整（行画不出来），分阶段补重渲染，
    // 单个 notify 可能被入场动画吞掉，多档位保险
    for (const delay of [250, 700, 1500]) {
      cx.spawn(async (cx) => {
        await cx.sleep(delay);
        cx.notify();
      });
    }
  }

  // 当前 tab 的会话：先取 focused pane 的终端；焦点在 mod pane 时回退到
  // 该 tab 的第一个 agent。会话 id 读 hc 终端的 herdr-mobile-relay.session 标签；
  // CLI 类别从 agents() 的 OSC app 上报拿。
  async refreshCurrent(cx) {
    const f = focused();
    const list = agents();
    const p = f?.pane ? panes().find((x) => x.pane === f.pane) : null;
    let addr = p?.terminal ?? f?.terminal ?? null;
    if (!addr && f?.tab) {
      addr = list.find((a) => a.tab === f.tab)?.address ?? null;
    }
    let key = null;
    if (addr) {
      const machine = addr.includes("/") ? addr.split("/")[0] : activeSpaceContext().machine;
      const terminal = machine && addr.startsWith(`${machine}/`) ? addr.slice(machine.length + 1) : addr;
      const r = await exec("hc", ["get", terminal, "--json"], { on: machine }).catch(() => null);
      if (r?.code === 0) {
        try {
          const id = JSON.parse(r.stdout).labels?.["herdr-mobile-relay.session"] ?? null;
          if (id) {
            const app = list.find((a) => a.address === addr)?.app;
            const cli = APP_TO_CLI[app] ?? null;
            key = cli ? `${cli}:${id}` : null;
          }
        } catch {
          key = null;
        }
      }
    }
    if (this.currentKey !== key) {
      this.currentKey = key;
      cx.notify();
    }
  }

  refresh(cx) {
    if (this.loading) {
      // Periodic ticks must not keep slow remote scans permanently queued.
      // Queue only when a context/filter change or mutation invalidated the scan.
      if (this.activeScan?.generation !== this.scanGeneration) this.refreshPending = true;
      return;
    }
    const context = activeSpaceContext();
    const generation = this.scanGeneration;
    const archived = this.showArchived;
    const scan = { generation };
    this.activeScan = scan;
    this.loading = true;
    // Herdr normally enforces the exec timeout. Also bound the UI wait if a
    // disconnected remote transport never settles its promise.
    cx.timer.after(35000, (cx) => {
      if (this.activeScan !== scan) return;
      this.activeScan = null;
      this.loading = false;
      if (generation === this.scanGeneration && context.id === activeSpaceContext().id) {
        this.error = "会话读取超时，请检查远端连接后点击刷新";
      }
      if (this.refreshPending) {
        this.refreshPending = false;
        this.refresh(cx);
      }
      cx.notify();
    });
    cx.spawn(async (cx) => {
      try {
        const r = await this.scan(context, archived);
        if (r.code !== 0) throw new Error(r.stderr || `scan.py 退出码 ${r.code}`);
        const data = JSON.parse(r.stdout || "{}");
        if (this.activeScan !== scan || generation !== this.scanGeneration || context.id !== activeSpaceContext().id) return;
        this.sessions = (data.sessions || [])
          .map((session) => ({ ...session, machine: context.machine }));
        this.error = (data.warnings || []).join("\n") || null;
        this.updated = Date.now();
      } catch (e) {
        if (this.activeScan === scan && generation === this.scanGeneration && context.id === activeSpaceContext().id) this.error = String(e);
      } finally {
        if (this.activeScan !== scan) return;
        this.activeScan = null;
        this.loading = false;
        if (this.refreshPending) {
          this.refreshPending = false;
          this.refresh(cx);
        }
        cx.notify();
      }
    });
  }

  async scannerSource() {
    if (this.remoteScanner) return this.remoteScanner;
    const source = await readTextFile(appHome() + "/mods/sessions/scan.py");
    if (source === null || !source.trim()) throw new Error("Cannot read the local Sessions scanner source");
    this.remoteScanner = base64Utf8(source);
    return this.remoteScanner;
  }

  async scan(context, archived = false) {
    const args = archived ? ["--archived"] : [];
    if (!context.machine) {
      // exec with an absolute Python-script argument loses stdout in this app;
      // preserve the proven local wrapper path.
      return exec("sh", ["-c", 'exec python3 "$@"', "sessions", appHome() + "/mods/sessions/scan.py", ...args], { timeout: 30000 });
    }
    const source = await this.scannerSource();
    // Herdr's remote exec wrapper can reinterpret a leading `-c` passed
    // directly to Python.  Its sh -c path is established by the local scanner
    // and keeps both dynamic values as positional parameters, never shell text.
    return exec(
      "sh",
      ["-c", 'exec python3 -c "$@"', "sessions", REMOTE_SCANNER_BOOTSTRAP, source, ...args],
      { on: context.machine, timeout: 30000 },
    );
  }

  filtered(context = activeSpaceContext()) {
    const q = this.query.value().trim().toLowerCase();
    const scope = this.scope ?? "space";
    return this.sessions.filter(
      (s) =>
        (scope === "all" || inSpace(s, context)) &&
        (this.cli === "all" || s.cli === this.cli) &&
        (!q || s.title.toLowerCase().includes(q) || s.cwd.toLowerCase().includes(q) || s.id.toLowerCase().includes(q)),
    );
  }

  resume(s, cx) {
    const cmd = CLI_META[s.cli]?.resume;
    const context = activeSpaceContext();
    if (s.archived || !cmd || !context.id || (s.machine ?? null) !== context.machine) return;
    run("tab.new", {
      space: context.id,
      folder: s.cwd || undefined,
      argv: cmd(s.id),
      name: s.title.replace(/\s+/g, " ").slice(0, 40) || undefined,
    });
    cx.notify();
  }

  openFolder(s, cx) {
    const context = activeSpaceContext();
    if (s.machine) {
      if (context.id && (s.machine ?? null) === context.machine) run("tab.new", { space: context.id, folder: s.cwd || undefined });
      cx.notify();
      return;
    }
    const plat = window()?.platform;
    exec(plat === "macos" ? "open" : "xdg-open", [s.cwd]).catch(() => {});
    cx.notify();
  }

  requestDelete(s, cx) {
    if (s.machine) {
      this.error = "Remote session deletion is disabled";
      cx.notify();
      return;
    }
    const key = sessionKey(s);
    if ((s.cli !== "traex" && !s.path) || this.currentKey === `${s.cli}:${s.id}` || this.actionKey) return;
    if (this.pendingDelete?.key !== key) {
      const pending = { key };
      this.pendingDelete = pending;
      cx.timer.after(5000, (cx) => {
        if (this.pendingDelete === pending) {
          this.pendingDelete = null;
          cx.notify();
        }
      });
      cx.notify();
      return;
    }

    this.pendingDelete = null;
    this.manageSession(s, "delete", cx);
  }

  manageSession(s, action, cx) {
    const context = activeSpaceContext();
    if (s.machine || context.machine || this.actionKey || this.currentKey === `${s.cli}:${s.id}`) return;
    if (!context.id || (s.machine ?? null) !== context.machine) return;
    if (action !== "delete" && s.cli !== "traex") return;
    const key = sessionKey(s);
    this.actionKey = key;
    this.actionError = null;
    this.scanGeneration += 1;
    cx.spawn(async (cx) => {
      try {
        const script = appHome() + "/mods/sessions/scan.py";
        const r = await exec(
          "sh",
          ["-c", 'exec python3 "$1" "$2" "$3" "$4"', "sessions", script, `--${action}`, s.cli, s.cli === "traex" ? s.id : s.path],
          { timeout: 30000 },
        );
        if (r.code !== 0) throw new Error(r.stderr || `会话操作退出码 ${r.code}`);
        this.scanGeneration += 1;
        if (context.id === activeSpaceContext().id) {
          this.sessions = this.sessions.filter((item) => sessionKey(item) !== key);
          this.refresh(cx);
        }
      } catch (error) {
        this.actionError = `会话操作失败：${String(error)}`;
      } finally {
        this.actionKey = null;
        cx.notify();
      }
    });
  }

  btn(label, t, fn) {
    return div()
      .px(8)
      .h(24)
      .rounded(6)
      .text_size(12)
      .cursor_pointer()
      .items_center()
      .bg(t.raised)
      .border_1()
      .border_color(t.border)
      .text_color(t.foreground)
      .on_click((_e, cx) => {
        // 行本身也支持点击恢复；阻止按钮点击继续冒泡，避免一次操作开两个 tab。
        cx.stop_propagation();
        fn(cx);
      })
      .child(label);
  }

  header(t, context) {
    const scope = this.scope ?? "space";
    return v_flex()
      .px(12)
      .py(10)
      .gap(8)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .items_center()
          .gap(8)
          .child(div().font_semibold().text_size(14).child("Sessions"))
          .child(div().flex_1())
          .child(this.btn(this.showArchived ? "返回会话" : "TRAE 归档", t, (cx) => {
            this.showArchived = !this.showArchived;
            this.cli = this.showArchived ? "traex" : "all";
            this.pendingDelete = null;
            this.actionError = null;
            this.scanGeneration += 1;
            this.sessions = [];
            this.updated = 0;
            this.refresh(cx);
            cx.notify();
          }))
          .child(div().text_size(11).text_color(t.dim).child(this.loading ? "刷新中…" : ""))
          .child(this.btn("刷新", t, (cx) => {
            this.refresh(cx);
            this.refreshCurrent(cx);
          })),
      )
      .child(
        h_flex()
          .gap(6)
          .children(
            [
              ["space", `当前 Space · ${context.name}`],
              ["all", "当前 Host 全部项目"],
            ].map(([key, label]) => {
              const on = scope === key;
              return div()
                .px(10)
                .h(24)
                .rounded(12)
                .text_size(12)
                .cursor_pointer()
                .items_center()
                .bg(on ? t.accent : t.raised)
                .text_color(on ? t.accent_foreground : t.muted)
                .on_click((_e, cx) => {
                  this.scope = key;
                  cx.notify();
                })
                .child(label);
            }),
          ),
      )
      .child(
        h_flex()
          .gap(6)
          .children(
            ["all", ...CLIS].map((k) => {
              const on = this.cli === k;
              const label = k === "all" ? "全部 CLI" : (CLI_META[k]?.label ?? k);
              return div()
                .px(10)
                .h(24)
                .rounded(12)
                .text_size(12)
                .cursor_pointer()
                .items_center()
                .bg(on ? t.accent : t.raised)
                .text_color(on ? t.accent_foreground : t.muted)
                .on_click((_e, cx) => {
                  this.cli = k;
                  cx.notify();
                })
                .child(label);
            }),
          ),
      )
      .child(
        div()
          .px(10)
          .h(30)
          .rounded(8)
          .bg(t.raised)
          .border_1()
          .border_color(t.border)
          .items_center()
          .child(Textarea.new(this.query).w_full()),
      );
  }

  row(s, t) {
    const meta = CLI_META[s.cli] ?? { label: s.cli };
    const isCurrent = this.currentKey === `${s.cli}:${s.id}`;
    const kids = [
      div().w(3).h(22).rounded(2).flex_none().bg(isCurrent ? t.accent : t.surface),
      div()
        .px(7)
        .h(20)
        .rounded(5)
        .text_size(11)
        .items_center()
        .flex_none()
        .bg(t.raised)
        .border_1()
        .border_color(t.border)
        .text_color(t.muted)
        .child(meta.label),
      v_flex()
        .flex_1()
        .min_w(0)
        .gap(2)
        .child(div().truncate().font_semibold().child(s.title.replace(/\n/g, " ")))
        .child(div().truncate().text_size(11).text_color(t.dim).child(s.cwd || "—")),
      div().text_size(11).text_color(t.dim).flex_none().w(58).text_right().child(fmtTime(s.mtime)),
    ];
    if (meta.resume && !s.archived) kids.push(this.btn("恢复", t, (cx) => this.resume(s, cx)));
    kids.push(this.btn(s.machine ? "终端" : "打开", t, (cx) => this.openFolder(s, cx)));
    if (!s.machine && (s.cli === "traex" || s.path) && this.currentKey !== `${s.cli}:${s.id}`) {
      const key = sessionKey(s);
      if (s.cli === "traex") kids.push(this.btn(s.archived ? "取消归档" : "归档", t, (cx) => this.manageSession(s, s.archived ? "unarchive" : "archive", cx)));
      const deleteLabel =
        this.actionKey === key ? "处理中…" : this.pendingDelete?.key === key ? (s.cli === "traex" ? "确认永久删除" : "确认删除") : "删除";
      kids.push(this.btn(deleteLabel, t, (cx) => this.requestDelete(s, cx)));
    }
    return h_flex()
      .h(46)
      .flex_none()
      .px(8)
      .gap(8)
      .items_center()
      .rounded(8)
      .cursor_pointer()
      .bg(isCurrent ? t.selected : t.surface)
      .children(kids)
      .on_click((_e, cx) => {
        if (CLI_META[s.cli]?.resume) this.resume(s, cx);
      });
  }

  footer(t, rows, context) {
    const scope = this.scope ?? "space";
    const kids = [
      div()
        .text_size(11)
        .text_color(t.dim)
        .child(
          `${rows.length} / ${this.sessions.length} 个会话` +
            (scope === "space" ? ` · ${context.name}` : " · 当前 Host 全部项目") +
            (context.machine ? ` · ${context.machine}` : "") +
            (this.updated ? ` · 更新于 ${fmtTime(Math.floor(this.updated / 1000))}` : ""),
        ),
    ];
    if (this.currentKey) kids.push(div().text_size(11).text_color(t.accent).child("● 当前 tab 的会话已高亮"));
    return h_flex().px(12).py(8).border_t(1).border_color(t.border).gap(8).items_center().children(kids);
  }

  render(cx) {
    // 自愈：实例被复用/隐藏时定时器可能不触发，渲染时发现列表为空且
    // 不在加载中，就补一次拉取（refresh 内部有 loading 防重入）。
    if (!this.updated && !this.sessions.length && !this.loading && !this.error) this.refresh(cx);
    const t = theme();
    const context = activeSpaceContext();
    const nextContextKey = JSON.stringify({ id: context.id, machine: context.machine, roots: context.roots });
    if (nextContextKey !== this.contextKey) {
      this.contextKey = nextContextKey;
      this.scanGeneration += 1;
      this.sessions = [];
      this.updated = 0;
      this.currentKey = null;
      this.error = null;
      this.actionError = null;
      this.refresh(cx);
      this.refreshCurrent(cx);
    }
    const rows = this.filtered(context);
    // popup 的 overlay.height 是上限，不会给 flex 子元素一个确定高度。
    // 若这里只用 flex_1，列表会在自然尺寸布局中收缩为 0；与内置 picker
    // 一样给滚动区显式高度，再由 popup 的最大高度约束整体尺寸。
    const listHeight = Math.min(460, Math.max(96, rows.length * 46 + 12));
    return v_flex()
      .id(this.uid)
      .w_full()
      .min_h(0)
      .bg(t.surface)
      .text_color(t.foreground)
      .text_size(13)
      .child(this.header(t, context))
      .child(
        v_flex()
          .h(listHeight)
          .min_h(0)
          .overflow_y_scrollbar()
          .p(6)
          .children([
            ...(this.actionError
              ? [div().p(8).text_size(12).text_color(t.muted).child(this.actionError)]
              : []),
            ...(this.error
              ? [div().p(8).text_size(12).text_color(t.muted).child(`加载失败：${this.error}`)]
              : []),
            ...(!this.error && !rows.length
              ? [
                  div().p(8).text_size(12).text_color(t.dim).child(this.loading ? "加载会话历史…" : "没有找到会话"),
                  div().p(8).text_size(11).text_color(t.dim).child("需要 python3；只列出最近 90 天的会话"),
                ]
              : []),
            ...rows.map((s) => this.row(s, t)),
          ]),
      )
      .child(this.footer(t, rows, context));
  }
}
