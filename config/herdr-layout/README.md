# Herdr layouts

- `emacs-main.json`：从 Herdr `main` layout 派生，tabs 使用仓库自有的
  `quick-tabs`，并固定显示 `+`、`Quick Commands`、`Files`、`Changes` 四个入口。
  三个后续入口共享右侧 panel：Quick Commands 是快捷命令检索/CRUD 面板，Files 是
  `emacs-files`，Changes 保持 Herdr 内置 diff renderer；三者按 space 记住最近选择。
  Sidebar 使用 `agent-addresses` 在每个 Agent 名称前显示其 Core address（如
  `t5`、`t7`、`t1h`）。Changes 不嵌入 Emacs Review。

Review 从 Emacs 普通项目文件 buffer 中用 `C-c h a` 创建或恢复，并在 Emacs
内完成、发送和清理，不要求 Herdr 维护共享 session。

`deploy-herdr.sh` 会将这里的 JSON 链接到 `~/.config/herdr-app/layouts/`，并默认切换到 `emacs-main`。使用 `--no-switch` 可只部署、不切换。
