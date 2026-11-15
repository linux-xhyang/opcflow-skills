# Sessions — herdr-app 会话历史列表 mod

在 herdr-app 里列出各 agent CLI（Claude Code / Codex / Grok / Cursor / pi）的会话历史，
支持搜索、CLI 过滤、当前 tab 会话高亮、一键恢复和打开项目目录。

## 安装

```bash
ln -s "$PWD/sessions" ~/.config/herdr-app/mods/sessions   # 软链接，改代码即热更新
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
| 标题 | jsonl 首条 user 消息；cwd 取自 jsonl 行内字段（用于恢复） |
| 当前 tab 高亮 | `hc get <addr>` 读 `herdr-mobile-relay.session` 标签 + `agents()` 的 OSC app 上报 |
| 恢复 | `tab.new {folder, argv: "<cli> resume <id>"}`，映射：claude `--resume` / codex `resume` / grok `resume`；cursor/pi 不提供恢复，只可打开目录 |
| 打开目录 | macOS `open`，Linux `xdg-open` |
| 自动刷新 | 每 30s + 手动"刷新"按钮 |

## 数据来源

与 herdr-core `session_log.rs` 一致：

| CLI | 目录 |
| --- | --- |
| Claude Code | `~/.claude/projects/<编码项目>/<uuid>.jsonl` |
| Codex | `~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl` |
| Grok | `$GROK_HOME/sessions`（默认 `~/.grok/sessions`） |
| Cursor | `~/.cursor/projects` |
| pi | `~/.pi/agent/sessions` |

## 注意事项

- 依赖 python3（PATH 中可用）
- codex/grok 的 resume id 按文件名推断（best-effort），如 CLI 版本不接受可自行改 `CLI_META` 里的命令
- 会话标题只在文件头部 128KB 内找；超长会话若首条消息在更深处会退化为文件名

## 已知坑（herdr-app 0.1.x 排查记录）

1. **exec 传绝对路径脚本参数会吞 stdout**：`exec("python3", [script])` 进程正常退出但 stdout 为空；必须用 `exec("sh", ["-c", 'python3 "$1"', "sessions", path])` 包装（files mod 同款模式）。
2. **多实例元素 id 冲突**：弹窗实例与侧边面板实例共存时，相同 `.id()` 会导致行画不出来。根节点 id 须实例唯一（`Date.now()`），行元素不要加 id。
3. **弹窗首帧布局不完整**：挂载瞬间渲染的行可能不显示（普通 div 正常），需要一次后续 re-render。init 里 `cx.sleep(600)` 后补一次 `cx.notify()` 解决；列表容器不要用 `.gap()`。
4. **gpui 色值没有 `transparent`**：用 `#00000000` 或与背景同色的 theme token。
