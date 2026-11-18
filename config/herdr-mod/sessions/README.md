# Sessions — herdr-app 会话历史列表 mod

在 herdr-app 里列出各 agent CLI（TraeX / Claude Code / Codex / Grok / Cursor / pi）的会话历史，
支持搜索、当前 Space / CLI 过滤、当前 tab 会话高亮、一键恢复、删除无效会话和打开项目目录。

## 安装

```bash
ln -s "$PWD/config/herdr-mod/sessions" ~/.config/herdr-app/mods/sessions  # 在仓库根目录执行
herdr-app check ~/.config/herdr-app/mods/sessions          # 验证
```

也由仓库根目录的 `deploy.sh` 统一部署。

## 打开方式

| 方式 | 命令 |
| --- | --- |
| 快捷键（推荐） | `⌘⇧H`：`mod.open:sessions`（按 mod.json 的 overlay 弹出，再按收起）。绑定：keys.json `"global": {"cmd-shift-h": "mod.open:sessions"}` |
| 命令行 | `herdr-app do mod.open '{"name":"sessions"}'`（toggle） |
| 侧边面板 | `herdr-app do pane.split '{"direction":"right","mod":"sessions"}'`（常驻右侧） |

## 功能

| 功能 | 实现 |
| --- | --- |
| 会话列表 | 当前 Space 所在 host：TRAE 使用标准 `thread/list` 分页读取逻辑会话；其余 CLI 扫描日志目录。最近 90 天，最多 400 条 |
| Space 过滤 | 默认只显示当前 host 且 cwd 位于当前激活 Space 工作目录内的会话；可切换“当前 Host 全部项目”，切换 Space/host 时自动跟随 |
| 标题 | TRAE 优先使用正式会话名称 `name`，其次 `preview`；其余 CLI 取 jsonl 首条 user 消息 |
| 当前 tab 高亮 | `hc get <addr>` 读 `herdr-mobile-relay.session` 标签 + `agents()` 的 OSC app 上报 |
| 恢复 | `tab.new {space, folder, argv: ["<cli>", "resume", "<id>"]}`，显式目标当前 Space；映射：TraeX `traecli resume` / Claude `--resume` / Codex `resume` / Grok `resume`；Cursor/pi 不提供恢复，只可打开目录 |
| 删除 | 本机行内两次确认，5 秒超时取消。TRAE 提示“确认永久删除”，按逻辑 UUID 调用 `traecli delete <id> --force`，保留官方历史依赖保护；其余 CLI 的单个日志移入 `.deleted/`。远端与当前高亮会话不可删除 |
| 归档 | 本机 TRAE 使用 `traecli archive <id>`；“TRAE 归档”入口查看归档列表，可“取消归档”。操作成功后重新读取列表 |
| 打开目录 | 本机为 macOS `open` / Linux `xdg-open`；远端改为在会话 cwd 新建 terminal |
| 自动刷新 | 每 10s + 手动"刷新"按钮；请求进行中不叠加定时刷新，仅在切换 Space、归档筛选或操作会话后补拉 |

## 数据来源

TRAE 以标准 app-server 为准，其余 CLI 的目录与 herdr-core `session_log.rs` 一致：

| CLI | 目录 |
| --- | --- |
| TraeX | `traecli app-server --stdio`，初始化后调用 `thread/list`（`useStateDbOnly: true`），从官方会话索引按 `nextCursor` 分页；继承 `TRAE_HOME` / `TRAECLI_HOME`，不自行读取历史分片或固定版本的 SQLite 数据库 |
| Claude Code | `~/.claude/projects/<编码项目>/<uuid>.jsonl` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` |
| Grok | `$GROK_HOME/sessions`（默认 `~/.grok/sessions`） |
| Cursor | `~/.cursor/projects` |
| pi | `~/.pi/agent/sessions` |

## 注意事项

- 依赖 python3；TRAE 还需要 PATH 中的 `traecli` 支持 `thread/list` 与 `archive` / `unarchive` / `delete`。
- 远端扫描不要求远端部署 Herdr mod：本机读取已部署的 `scan.py`，通过 `python3 -c` 在目标 machine 内存执行同一源码；结果带 host 身份，绝不与本地结果混合。
- TRAE 使用标准列表返回的逻辑会话 `id` 恢复，默认交互来源过滤由 TRAE 实现；当前 tab 高亮兼容 `traecli` 的 OSC app 标识。
- 同一 TRAE 会话可以有多个分页历史文件，它们不是独立会话。禁止将 TRAE 的 `.jsonl` 路径传给删除助手；`--force` 只跳过 CLI 二次提示，不绕过历史依赖保护。
- TRAE 列表接口失败时显示原因，并继续列出其他 CLI；不会退回逐文件扫描。每次列表读取使用短生命周期的标准 stdio 服务，完成或超时后关闭，不启动对话轮次。
- 列表读取不触发全量历史扫描/元数据修复，避免旧版远端 TRAE 被大量历史文件拖慢。扫描器限制为 20 秒，Herdr 执行限制为 30 秒，界面另有 35 秒超时保护；过期结果不会覆盖后续列表。
- “TRAE 归档”只列归档的 TRAE 会话；仍应用当前 Space 和搜索条件。远端可以查看归档列表，修改操作仍仅允许本机。
- codex/grok 的 resume id 按文件名推断（best-effort），如 CLI 版本不接受可自行改 `CLI_META` 里的命令
- 其他 CLI 会话标题只在文件头部 128KB 内找；超长会话若首条消息在更深处会退化为文件名。

## 已知坑（herdr-app 0.1.x 排查记录）

1. **exec 传绝对路径脚本参数会吞 stdout**：`exec("python3", [script])` 进程正常退出但 stdout 为空；用 `exec("sh", ["-c", 'exec python3 "$@"', "sessions", path, ...args])` 包装，动态参数始终作为独立 argv。
2. **多实例元素 id 冲突**：弹窗实例与侧边面板实例共存时，相同 `.id()` 会导致行画不出来。根节点 id 须实例唯一（`Date.now()`），行元素不要加 id。
3. **popup 的 `overlay.height` 只是上限**：自然尺寸 popup 中，纯 `.flex_1()` 列表会收缩为 0 高度，表现为底部有会话计数但没有任何行。根节点使用 `.w_full()`，滚动区必须设置显式且有上限的 `.h(...)`；延迟 `cx.notify()` 只解决异步数据到达后的重绘，不能代替高度约束。
4. **gpui 色值没有 `transparent`**：用 `#00000000` 或与背景同色的 theme token。
5. **`tab.new.argv` 必须是参数数组**：传入 `"traecli resume <id>"` 这样的整条字符串会被当成无效 agent 参数，最终只打开空 shell；必须传 `["traecli", "resume", id]`。行内按钮还需要 `cx.stop_propagation()`，否则会继续触发行点击并重复恢复。
