# opcflow-skills

个人技能库与 herdr-core 配置，通过 `deploy.sh` 部署到本机（兼容 macOS / Linux）。

## 部署

```bash
./deploy.sh            # 部署（幂等，可重复执行）
./deploy.sh --dry-run  # 预览将要执行的操作
```

部署内容：

| 内容 | 方式 | 目标目录 |
| --- | --- | --- |
| `skills/*` | 软链接 | `~/.agents/skills` 通用 skill 目录（可用 `SKILLS_DIR` 覆盖） |
| Claude 桥接 | 软链接 | `~/.claude/skills`（指向通用目录，`--no-claude` 跳过） |
| `herdr-mod/*` | 软链接 | `~/.config/herdr-app/mods`（可用 `HERDR_MODS_DIR` 覆盖） |
| `config/herdr-core` | 复制 | `${XDG_CONFIG_HOME:-~/.config}/herdr-core`（可用 `HERDR_CONFIG_DIR` 覆盖） |

## herdr mods

- [sessions](herdr-mod/sessions/README.md)：herdr-app 会话历史列表面板——列出各 agent CLI（Claude Code/Codex/Grok/Cursor/pi）的会话，支持搜索、CLI 过滤、当前 tab 会话高亮、一键恢复（`claude --resume` / `codex resume`）和打开项目目录。

打开方式：`herdr-app do pane.split '{"direction":"right","mod":"sessions"}'`

## 第三方 skills

```bash
./deploy-third-party.sh            # 安装第三方 skills 并桥接 Claude Code
./deploy-third-party.sh --dry-run  # 预览将执行的命令
```

| 仓库 | 内容 |
| --- | --- |
| [mattpocock/skills](https://github.com/mattpocock/skills) | 22 个开发流程技能（grilling、domain-modeling、tdd、code-review、wizard 等），用法参考 [aihero.dev/skills](https://www.aihero.dev/skills) |
| [tt-a1i/archify](https://github.com/tt-a1i/archify) | archify：把需求/Mermaid 生成可交互 HTML 架构图、流程图、时序图等 |

- 通过 `npx skills@latest add <repo> -g -y` 全局安装到 `~/.agents/skills`（清单自动去重）
- 安装后把新技能桥接一份软链接到 `~/.claude/skills`（`--no-claude` 跳过，需 Node.js）
