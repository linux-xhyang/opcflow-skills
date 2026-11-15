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
| 会话列表 | `scan.py` 一次扫描各 CLI 会话日志目录（最近 90 天，最多 400 条，每条只读文件前 128KB 取标题） |
| Space 过滤 | 默认只显示 cwd 位于当前激活 Space 工作目录内的会话；可切换“全部 Space”，切换 Space 时自动跟随 |
| 标题 | jsonl 首条 user 消息；cwd 取自 jsonl 行内字段（用于恢复） |
| 当前 tab 高亮 | `hc get <addr>` 读 `herdr-mobile-relay.session` 标签 + `agents()` 的 OSC app 上报 |
| 恢复 | `tab.new {folder, argv: ["<cli>", "resume", "<id>"]}`，映射：TraeX `traecli resume` / Claude `--resume` / Codex `resume` / Grok `resume`；Cursor/pi 不提供恢复，只可打开目录 |
| 删除 | 行内两次确认后，把对应 `.jsonl` 移到该 CLI 会话根目录的 `.deleted/`；当前高亮会话不可删除，5 秒未确认会自动取消 |
| 打开目录 | macOS `open`，Linux `xdg-open` |
| 自动刷新 | 每 30s + 手动"刷新"按钮 |

## 数据来源

与 herdr-core `session_log.rs` 一致：

| CLI | 目录 |
| --- | --- |
| TraeX | `$TRAE_HOME/cli/sessions/YYYY/MM/DD/rollout-*.jsonl`（默认 `~/.trae/cli/sessions`）；标题取 `$TRAE_HOME/cli/history.jsonl` |
| Claude Code | `~/.claude/projects/<编码项目>/<uuid>.jsonl` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` |
| Grok | `$GROK_HOME/sessions`（默认 `~/.grok/sessions`） |
| Cursor | `~/.cursor/projects` |
| pi | `~/.pi/agent/sessions` |

## 注意事项

- 依赖 python3（PATH 中可用）
- TraeX 使用 `session_meta.payload.id` 恢复，并过滤内部 subagent rollout；当前 tab 高亮兼容 `traecli` 的 OSC app 标识
- codex/grok 的 resume id 按文件名推断（best-effort），如 CLI 版本不接受可自行改 `CLI_META` 里的命令
- 会话标题只在文件头部 128KB 内找；超长会话若首条消息在更深处会退化为文件名

## 已知坑（herdr-app 0.1.x 排查记录）

1. **exec 传绝对路径脚本参数会吞 stdout**：`exec("python3", [script])` 进程正常退出但 stdout 为空；必须用 `exec("sh", ["-c", 'python3 "$1"', "sessions", path])` 包装（files mod 同款模式）。
2. **多实例元素 id 冲突**：弹窗实例与侧边面板实例共存时，相同 `.id()` 会导致行画不出来。根节点 id 须实例唯一（`Date.now()`），行元素不要加 id。
3. **popup 的 `overlay.height` 只是上限**：自然尺寸 popup 中，纯 `.flex_1()` 列表会收缩为 0 高度，表现为底部有会话计数但没有任何行。根节点使用 `.w_full()`，滚动区必须设置显式且有上限的 `.h(...)`；延迟 `cx.notify()` 只解决异步数据到达后的重绘，不能代替高度约束。
4. **gpui 色值没有 `transparent`**：用 `#00000000` 或与背景同色的 theme token。
5. **`tab.new.argv` 必须是参数数组**：传入 `"traecli resume <id>"` 这样的整条字符串会被当成无效 agent 参数，最终只打开空 shell；必须传 `["traecli", "resume", id]`。行内按钮还需要 `cx.stop_propagation()`，否则会继续触发行点击并重复恢复。
