# quick-commands

Herdr 的项目快捷命令面板。它和 Files、Changes 是同级的右侧 panel；从顶部的
`Quick Commands` 入口打开，入口位于 `+` 和 `Files` 之间。面板用于检索、添加、
编辑、删除并启动两类持久化命令：

- **Shell**：在当前 Herdr space、当前终端目录（或 space folder）新建 tab，
  以 `sh -lc <command>` 执行保存的命令。
- **Agent**：使用 Herdr `knownAgents()` 返回的已安装 agent CLI 创建 tab，并通过
  `tab.new { argv, task }` 注入保存的首条提示词。

命令定义存在 Herdr 的持久化 shared state，键为 `opcflow.quick-commands@1`，但
按 Herdr `space.id` 分桶：切换到另一个 space 不会显示、编辑或运行当前 space
的命令。它不保存 agent CLI 的 argv；运行时重新查询当前 machine，因而能遵循当前
`programs.json` 的 agent 配置，也会在 CLI 未安装时拒绝启动。

仓库默认注册 `traex`（显示为 `TRAE CLI`，启动 argv 为 `traex`）；它匹配
`traex` 和 `traecli` 进程名，并会和其他已安装 agent 一起出现在 Agent prompt
表单中。

早期版本曾使用全局列表。升级后会显示 legacy 提示；选择 `Import here` 才会把
旧命令导入当前 space，其他 space 不会自动获得它们。

删除要求两次点击确认。搜索覆盖名称、类型、shell 文本、agent key 和提示词。

测试：

```bash
npm test --prefix config/herdr-mod/quick-commands
```
