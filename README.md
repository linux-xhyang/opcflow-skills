# opcflow-skills

个人技能库、Herdr 配置与实现中的 `herdr-flow` Coordinator。三部分可独立使用：
skills 和 Herdr 分别由专用部署脚本管理；`herdr-flow` 目前只作为源码和验证目标，
不由部署脚本安装生产配置。

## 个人技能

### 目录

| 路径 | 内容 |
| --- | --- |
| [`skills/`](skills) | 本仓库维护的通用 skills。 |
| [`deploy-skills.sh`](deploy-skills.sh) | 将 skills 部署到通用目录，并按需桥接 Claude Code。 |
| [`deploy-third-party.sh`](deploy-third-party.sh) | 安装和桥接指定的第三方 skills。 |

### 部署

```bash
./deploy-skills.sh             # 部署仓库 skills 与 Claude Code 桥接
./deploy-skills.sh --dry-run   # 预览 skill deploy
./deploy-skills.sh --no-claude # 不创建 Claude Code 桥接
```

部署会把 `skills/*` 软链接到 `~/.agents/skills`（可用 `SKILLS_DIR` 覆盖），
并默认在 `~/.claude/skills` 创建桥接链接。脚本幂等；遇到非本仓库管理的同名
文件或目录会跳过并告警，不会覆盖用户内容。

### 第三方 skills

```bash
./deploy-third-party.sh            # 安装第三方 skills 并桥接 Claude Code
./deploy-third-party.sh --dry-run  # 预览将要执行的命令
```

| 仓库 | 内容 |
| --- | --- |
| [mattpocock/skills](https://github.com/mattpocock/skills) | 22 个开发流程技能（grilling、domain-modeling、tdd、code-review、wizard 等），用法参考 [aihero.dev/skills](https://www.aihero.dev/skills) |
| [tt-a1i/archify](https://github.com/tt-a1i/archify) | archify：把需求/Mermaid 生成可交互 HTML 架构图、流程图、时序图等 |

第三方安装通过 `npx skills@latest add <repo> -g -y` 写入 `~/.agents/skills`，
清单自动去重；安装后可用 `--no-claude` 跳过 Claude Code 桥接。

## Herdr 配置

### 目录

| 路径 | 内容 |
| --- | --- |
| [`config/herdr-mod/`](config/herdr-mod) | Herdr 自定义 mods。 |
| [`config/herdr-layout/`](config/herdr-layout) | `emacs-main` 等布局配置。 |
| [`config/herdr-app/`](config/herdr-app) | 应用快捷键配置。 |
| [`config/herdr-core/`](config/herdr-core) | Herdr Core 配置。 |
| [`config/herdr-flow/`](config/herdr-flow) | portable Bug Workflow、schema、Project Profile 与 TRAE 默认配置。 |
| [`deploy-herdr.sh`](deploy-herdr.sh) | 独立部署 Herdr 配置。 |

### 部署

```bash
./deploy-herdr.sh             # 部署 Herdr，并切换到 emacs-main layout
./deploy-herdr.sh --dry-run   # 预览 Herdr deploy
./deploy-herdr.sh --no-switch # 部署 Herdr，但不切换当前 layout

./deploy.sh                   # 兼容入口：依次部署 skills 与 Herdr
./deploy.sh --dry-run         # 预览全部部署操作
```

| 脚本 | 内容 | 方式与目标 |
| --- | --- | --- |
| `deploy-herdr.sh` | `config/herdr-mod/*` | 软链接到 `~/.config/herdr-app/mods` |
| `deploy-herdr.sh` | `config/herdr-layout/*.json` | 软链接到 `~/.config/herdr-app/layouts` |
| `deploy-herdr.sh` | `config/herdr-app/keys.json` | 增量合并，保留已有快捷键与冲突项 |
| `deploy-herdr.sh` | `config/herdr-app/programs.json` | 增量合并到 `~/.config/herdr-app/programs.json`，注册自定义 agent/program |
| `deploy-herdr.sh` | `config/herdr-core` | 复制到 `${XDG_CONFIG_HOME:-$HOME/.config}/herdr-core` |

### 自定义 mods

- [emacs-files](config/herdr-mod/emacs-files/README.md)：保留 Files 目录树；普通文件单击通过安全 argv 调用 `emacsclient --no-wait -- <absolute-path>`。配套 [emacs-main layout](config/herdr-layout/README.md) 不会修改会被 Herdr 启动覆盖的内置 Files mod。
- [quick-commands](config/herdr-mod/quick-commands/README.md)：与 Files、Changes 同级的命令检索和 CRUD 面板；顶部入口固定排列为 `+`、`Quick Commands`、`Files`、`Changes`。Shell 命令新建 terminal 执行，Agent 命令用对应 CLI 新建 tab 并注入保存的提示词。
- [agent-addresses](config/herdr-mod/agent-addresses/README.md)：Sidebar Agents 列表，保留原有交互并在名称前显示对应 Core terminal address（如 `t5`、`t7`、`t1h`）。
- [emacs-review](config/herdr-mod/emacs-review/README.md)：历史兼容模块；不嵌入 Changes 面板。当前项目 Review 由 Emacs 在普通文件 buffer 中结合 `diff-hl` 独立创建、恢复并直接发送给 agent。
- [sessions](config/herdr-mod/sessions/README.md)：会话历史面板，支持搜索、CLI 过滤、当前 tab 会话高亮、一键恢复（`claude --resume` / `codex resume`）和打开项目目录。

打开会话面板：`herdr-app do pane.split '{"direction":"right","mod":"sessions"}'`。

## Herdr Workflow

### 目录

| 路径 | 内容 |
| --- | --- |
| [`src/herdr_flow/`](src/herdr_flow) | `herdr-flow` Coordinator Python 包。 |
| [`tests/`](tests) | 确定性回归与 fixture。 |
| [`docs/herdr-flow/`](docs/herdr-flow) | Workflow、运行时、验证与 operability contracts。 |
| [`docs/wayfinder/herdr-flow-implementation/`](docs/wayfinder/herdr-flow-implementation) | 实现路线图与 ticket 状态。 |

### 实现状态

`herdr-flow` 是薄型、确定性的 Coordinator，业务真相保存在本地 durable Run
store，而非 Herdr 文档。当前已覆盖：版本化配置与 project binding、Run/Artifact/
journal/operation recovery、structured JSON-RPC Herdr Core adapter、Workspace
安全与精确 Git effect、Provider capability qualification，以及 `bug-fix@1.0.0`
的静态 workflow/Gate/Stage 生命周期和 durable Bug validation/repair/escalation
loop。CLI 启动与恢复入口仍由后续 Wayfinder ticket 交付。

实现范围、尚未启用的能力和交付顺序以
[Wayfinder implementation map](docs/wayfinder/herdr-flow-implementation/map.md)
为准。当前已提供 `bug-fix@1.0.0` portable 生产配置和五个 Herdr 原生角色模板；
`deploy*.sh` 尚不会安装或启用 Coordinator，部署事务仍由后续 ticket 交付。

### 只读诊断

```bash
herdr-flow doctor config \
  --project spatial-runtime \
  --portable-root /path/to/config/herdr-flow \
  --local-root "${XDG_CONFIG_HOME:-$HOME/.config}/herdr-flow" \
  --json

herdr-flow doctor providers \
  --provider traex \
  --profile reviewer-read-only \
  --json
```

两条 doctor 命令都不会启动 Core/Provider、获取设备或运行构建/测试。尚未接入
portable Provider 配置时，Provider doctor 会以 exit 10 返回脱敏的
`provider_context_required`。

### 验证

```bash
PYTHONPATH=src python3 -m unittest \
  tests.test_cli_version \
  tests.test_deterministic_primitives \
  tests.test_configuration \
  tests.test_configuration_doctor \
  tests.test_run_store \
  tests.test_run_store_records \
  tests.test_run_store_inspection \
  tests.test_run_store_faults \
  tests.test_herdr_connection \
  tests.test_herdr_adapter \
  tests.test_herdr_fake_core \
  tests.test_herdr_live_core \
  tests.test_workspace \
  tests.test_workspace_set \
  tests.test_provider_launcher \
  tests.test_providers \
  tests.test_workflow \
  tests.test_artifacts \
  tests.test_gates \
  tests.test_stage_executor \
  tests.test_bug_loop \
  tests.test_acceptance -v
python3 -m unittest tests.test_wheel_installation -v
```

Wheel 测试使用 `UV_OFFLINE=1` 与本机现有 uv cache，在临时目录中分别创建
Python 3.11/3.12 venv；它不进行网络解析。需显式运行隔离的 T3 Core 验收时：

```bash
HERDR_FLOW_T3_LIVE=1 PYTHONPATH=src \
  python3 -m unittest tests.test_herdr_live_core -v
```

T3 会创建独立的短 `HC_SESSION`、临时 HOME/XDG/socket/Artifact root 和
deterministic status emitter，并要求 macOS 允许该隔离 Core 启动自己的 PTY
holder。holder 不可用、任一 skip、teardown 未验证或访问默认 Core 都是验收失败，
不会被降级为通过。
