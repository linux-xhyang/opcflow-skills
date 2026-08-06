---
name: opc-anysearch
description: 公共网页搜索后端。提供关键词检索、垂直领域发现、批量并行搜索和原文核验能力。使用匿名公开索引，不依赖账号登录态。被 opc-unified-search 作为默认后端调用。
---

# AnySearch 公共网页搜索

匿名、只读的公共网页搜索后端。不要求 API Key 即可使用默认匿名额度。

## 固定边界

1. 只搜索和读取公开网页内容；不爬取、不建立索引、不存储搜索结果。
2. 使用第三方公开索引（DuckDuckGo）；结果不保证完整或穷尽。
3. 不绕过验证码、登录墙或限流。缺失字段写 `null`，零结果只表示本次后端未返回候选。
4. 不得提交密码、Cookie、个人数据或商业秘密作为查询。
5. `extract` 只做轻量核验（标题提取），不是全文下载或归档。

## 命令

```bash
<anysearch_cmd> search "query" --max_results 10
<anysearch_cmd> extract "https://example.com/article"
<anysearch_cmd> batch_search --queries '[{"query":"q1","max_results":10},{"query":"q2","max_results":10}]'
<anysearch_cmd> get_sub_domains --domain legal
<anysearch_cmd> search "query" --domain legal --sub_domain "case_law" --sub_domain_params '{"jurisdiction":"us"}'
```

`<anysearch_cmd>` 从 `runtime.conf` 的 `Command` 字段读取。

## 支持的垂直领域

- academic - 学术论文与引用
- finance - 金融市场与监管
- legal - 法律案例与法规
- security - 安全漏洞与威胁情报
- social_media - 公开社交媒体讨论

使用 `get_sub_domains --domain <name>` 发现各领域下的子域和必填参数。

## 输出格式

所有命令输出带 `schema_version` 的 JSON envelope，候选结构遵循 `opc-unified-search` 的 candidate-schema。
