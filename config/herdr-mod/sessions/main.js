// Sessions: herdr-app 会话历史列表 panel mod。
//
// 列出各 agent CLI（TraeX / Claude Code / Codex / Grok / Cursor / pi）的会话历史：
//   - 搜索（标题 / 项目路径）、按 CLI 过滤
//   - 当前 tab 的会话高亮（读 hc 终端的 herdr-mobile-relay.session 标签）
//   - 恢复：在新 tab 里跑对应 CLI 的 resume 命令
//   - 打开会话所在项目目录（macOS: open，Linux: xdg-open）
//
// 数据来源: scan.py（一次 exec，读各 CLI 的会话日志目录，只取每文件前 128KB 的标题）。
// 打开方式: pane.split {"direction": "right", "mod": "sessions"}
import { View, div } from "gpui-kit";
import { v_flex, h_flex, Textarea, TextareaState } from "gpui-base";
import { theme, exec, run, spaces, panes, focused, agents, appHome, window } from "herdr";

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

function normalizePath(path) {
  return (path || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

function activeSpaceContext() {
  const space = spaces().find((s) => s.active);
  if (!space) return { id: null, name: "当前 Space", roots: [] };
  const tabs = new Set((space.tabs ?? []).map((tab) => tab.id));
  const paneRoots = panes()
    .filter((pane) => tabs.has(pane.tab) && pane.cwd)
    .map((pane) => normalizePath(pane.cwd));
  // live pane 的 cwd 比 space 创建时的 folder 更准确；后者可能只是 $HOME。
  const candidates = paneRoots.length ? paneRoots : [normalizePath(space.folder)];
  const roots = [...new Set(candidates.filter(Boolean))].filter(
    (path, _index, all) => !all.some((other) => other !== path && path.startsWith(other + "/")),
  );
  return { id: space.id, name: space.name || "当前 Space", roots };
}

function inSpace(session, context) {
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
    this.deletingPath = null;
    this.deletedPaths = new Set();
    this.currentKey = null; // `${cli}:${id}` 当前 tab 的会话
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
      const r = await exec("hc", ["get", addr, "--json"]).catch(() => null);
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
    if (this.loading) return;
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        // 注意：exec 直接传绝对路径脚本参数时 stdout 会被吞（app 端怪癖），
        // 用 sh -c 'python3 "$1"' 包装（files mod 同款模式）输出才正常。
        const r = await exec("sh", ["-c", 'python3 "$1"', "sessions", appHome() + "/mods/sessions/scan.py"], {
          timeout: 30000,
        });
        if (r.code !== 0) throw new Error(r.stderr || `scan.py 退出码 ${r.code}`);
        const data = JSON.parse(r.stdout || "{}");
        this.sessions = (data.sessions || []).filter((s) => !this.deletedPaths.has(s.path));
        this.error = null;
        this.updated = Date.now();
      } catch (e) {
        this.error = String(e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
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
    if (!cmd) return;
    run("tab.new", {
      folder: s.cwd || undefined,
      argv: cmd(s.id),
      name: s.title.replace(/\s+/g, " ").slice(0, 40) || undefined,
    });
    cx.notify();
  }

  openFolder(s, cx) {
    const plat = window()?.platform;
    exec(plat === "macos" ? "open" : "xdg-open", [s.cwd]).catch(() => {});
    cx.notify();
  }

  requestDelete(s, cx) {
    if (!s.path || this.currentKey === `${s.cli}:${s.id}` || this.deletingPath === s.path) return;
    if (this.pendingDelete?.path !== s.path) {
      const pending = { path: s.path };
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
    this.deletingPath = s.path;
    cx.spawn(async (cx) => {
      try {
        const script = appHome() + "/mods/sessions/scan.py";
        const r = await exec(
          "sh",
          ["-c", 'python3 "$1" --delete "$2" "$3"', "sessions", script, s.cli, s.path],
          { timeout: 30000 },
        );
        if (r.code !== 0) throw new Error(r.stderr || `删除命令退出码 ${r.code}`);
        this.deletedPaths.add(s.path);
        this.sessions = this.sessions.filter((item) => item.path !== s.path);
        this.error = null;
      } catch (error) {
        this.error = `删除失败：${String(error)}`;
      } finally {
        this.deletingPath = null;
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
              ["all", "全部 Space"],
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
    if (meta.resume) kids.push(this.btn("恢复", t, (cx) => this.resume(s, cx)));
    kids.push(this.btn("打开", t, (cx) => this.openFolder(s, cx)));
    if (s.path && this.currentKey !== `${s.cli}:${s.id}`) {
      const deleteLabel =
        this.deletingPath === s.path ? "删除中…" : this.pendingDelete?.path === s.path ? "确认删除" : "删除";
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
            (scope === "space" ? ` · ${context.name}` : " · 全部 Space") +
            (this.updated ? ` · 更新于 ${fmtTime(Math.floor(this.updated / 1000))}` : ""),
        ),
    ];
    if (this.currentKey) kids.push(div().text_size(11).text_color(t.accent).child("● 当前 tab 的会话已高亮"));
    return h_flex().px(12).py(8).border_t(1).border_color(t.border).gap(8).items_center().children(kids);
  }

  render(cx) {
    // 自愈：实例被复用/隐藏时定时器可能不触发，渲染时发现列表为空且
    // 不在加载中，就补一次拉取（refresh 内部有 loading 防重入）。
    if (!this.sessions.length && !this.loading && !this.error) this.refresh(cx);
    const t = theme();
    const context = activeSpaceContext();
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
