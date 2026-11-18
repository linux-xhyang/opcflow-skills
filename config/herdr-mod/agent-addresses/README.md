# agent-addresses

Sidebar 的 Agents 列表，保留 Herdr 内置 agent 分组、排序、pin、状态和 sub-agent
展示行为，并在每个名称前增加对应 Herdr Core terminal address badge：本机显示
`t5`、`t7`、`t1h` 等；远端地址显示其末段，悬停可查看完整 `machine/tN`。

内置 `agents` mod 会在 Herdr 启动时覆盖，因此地址显示通过这个仓库自有 wrapper
实现。
