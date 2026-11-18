# emacs-review

Herdr 侧只提供一个轻量入口：把当前本地 Git 项目和可选的 agent target hint
一次性传给 Emacs。它不拥有新 Review 的 session、Finding、overlay 或发送状态，
也不会等待 Emacs 回传结果。

新流程只有一条跨进程调用：

```text
Herdr -> emacsclient --no-wait --eval
      -> hc-review-start-project-from-base64(<start@1 intent>)
```

`hc-review/start@1` 只包含：

- `root`：本地 Git 项目绝对路径；
- `target`：可选的 `{address, title}` 提示。没有 live agent 时仍可打开
  Review，Finish 时由 Emacs 选择目标。

Emacs 自己负责按项目创建或恢复 durable Review、在普通项目文件 buffer 中结合
`diff-hl` 遍历变更、维护 Finding overlays，并在 Finish 时直接通过 `hc` 发送。
Herdr 重启、切 layout、隐藏面板或退出都不会中断已经开始的 Review。

`main.js` 中仍保留 `request@1/result@1/cancel@1` mailbox 的读取和发送逻辑，
只用于完成升级前已经存在的历史 session。`Open Review` 不会创建
`~/.config/herdr-app/review-sessions/`、`request.json` 或 `state.json`。

当前入口只支持本机 space；远端 space 会明确禁用。普通文件使用
`git hash-object`、符号链接使用 `lstat`/`readlink` 的 snapshot helper 也仅供
legacy session 校验，因此 broken symlink 不会破坏历史 Review 恢复。

回归测试：

```bash
npm test --prefix config/herdr-mod/emacs-review
```

整体边界、恢复语义和 Emacs 交互见
[设计文档](../../../docs/herdr-emacs-review-design.md)。
