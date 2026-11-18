# quick-tabs

仓库自有的 Herdr tabs mod，基于内置 tabs 行为维护每个 space 的 panel 选择；唯一
增加的是固定顺序的 panel controls：

```text
+  |  Quick Commands  |  Files  |  Changes
```

它让 `quick-commands` 与 Files、Changes 成为同级可切换 panel，而不是把快捷命令
嵌入 Files 内容或长期占用主工作区。内置 tabs mod 会随 Herdr 启动覆盖，因此不能
直接修改它。
