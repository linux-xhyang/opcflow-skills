# emacs-files

Herdr 内置 Files mod 的用户自有变体。目录浏览行为保持不变，普通文件单击改为执行：

```text
emacsclient --no-wait -- <absolute-path>
```

调用使用 Herdr `exec(command, args, options)` 的独立参数数组，不经过 shell。当前 space 是远端机器时，`emacsclient` 也在该机器执行；远端必须安装 `emacsclient` 并有可连接的 Emacs server。

本目录由 `deploy-herdr.sh` 链接到 `~/.config/herdr-app/mods/emacs-files`，不要直接修改 Herdr 自带的 `mods/files`。
