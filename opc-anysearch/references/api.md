# AnySearch CLI API

## 命令参考

### search

```bash
<anysearch_cmd> search "query" --max_results <1-10> [--domain <domain>] [--sub_domain <name>] [--sub_domain_params '<json>'] [--timeout <seconds>]
```

| 参数 | 必需 | 默认 | 说明 |
|---|---|---|---|
| `query` | 是 | - | 搜索关键词（位置参数） |
| `--max_results` | 否 | 10 | 返回候选数上限（最多 10） |
| `--domain` | 否 | - | 垂直领域名（见 get_sub_domains） |
| `--sub_domain` | 否 | - | 子域标识 |
| `--sub_domain_params` | 否 | `{}` | 子域必填参数 JSON |
| `--timeout` | 否 | 15 | 请求超时秒数 |

### extract

```bash
<anysearch_cmd> extract "<url>" [--timeout <seconds>]
```

提取目标 URL 的标题用于核验。不返回全文。

### batch_search

```bash
<anysearch_cmd> batch_search --queries '<json-array>'
```

`--queries` 接受 JSON 数组，每项含 `query` 和可选 `max_results`。单批最多 5 个查询。

### get_sub_domains

```bash
<anysearch_cmd> get_sub_domains --domain <name>
```

返回指定垂直领域的所有子域及其必填参数。

## 输出结构

### search / batch_search

```json
{
  "schema_version": "1.0",
  "request": {"queries": ["..."], "platforms": ["web"], "time_range": null, "requested_limit": 10},
  "routes": [{"platform": "web", "backend": "anysearch", "mode": "search", "login_state_used": false, "status": "completed", "limitations": []}],
  "candidates": [{"candidate_id": "...", "title": "...", "url": "...", "snippet": "...", ...}],
  "coverage": [{"platform": "web", "backend": "anysearch", "returned_count": 5, ...}],
  "errors": []
}
```

### extract

返回单个 candidate，`verification.status` 为 `"verified"`。

### get_sub_domains

```json
{
  "domain": "legal",
  "description": "Legal cases, statutes, and regulations",
  "sub_domains": [{"name": "case_law", "label": "Case Law", "description": "...", "required_params": ["jurisdiction"]}]
}
```

### 错误

```json
{
  "schema_version": "1.0",
  "routes": [{"status": "failed"}],
  "candidates": [],
  "errors": [{"backend": "anysearch", "category": "network_error", "message": "..."}]
}
```
