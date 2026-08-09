---
name: opc-doctor
description: opcflow 技能栈依赖体检工具。检查 opc-unified-search、opc-content-archive、opc-anysearch 所需的 CLI 工具、Python 脚本、配置文件和运行环境，报告各后端可用状态，并提供缺失依赖的安装指引。只读取本地文件系统和 PATH，不联网、不读取私人内容。
---

# opc-doctor 依赖体检

检查 opcflow 三个 skill 的所有后端依赖，输出 JSON 体检报告。

## 固定边界

1. 只读取本地文件系统与 PATH；不联网、不访问远程服务。
2. 不读取私人内容、书签、Cookie、浏览器状态或登录态。
3. 不安装任何依赖；只报告状态和安装指引。
4. 命令存在不等于可用；对关键后端做合约校验。

## 使用

```bash
python3 .claude/skills/opc-doctor/scripts/opc_doctor.py
```

可选 `--skill` 限定检查范围：

```bash
python3 .claude/skills/opc-doctor/scripts/opc_doctor.py --skill unified-search
python3 .claude/skills/opc-doctor/scripts/opc_doctor.py --skill content-archive
python3 .claude/skills/opc-doctor/scripts/opc_doctor.py --skill anysearch
```

## 输出结构

```json
{
  "opcflow_version": "1.0",
  "skills": {
    "unified-search": {"status": "ok", "backends": {...}},
    "content-archive": {"status": "ok", "backends": {...}},
    "anysearch": {"status": "ok", "backends": {...}}
  },
  "summary": {"ok": 12, "warn": 3, "error": 0},
  "recommendations": ["brew install gh", ...]
}
```

## 受检项

| 类别 | 后端 | 检查方式 |
|---|---|---|
| CLI | `gh` | `which gh` |
| CLI | `opencli` | `which opencli` + 子命令 help 合约校验 |
| CLI | `bili` | `which bili` |
| CLI | `yt-dlp` | `which yt-dlp` |
| CLI | `grok` | `which grok` + `grok models` 登录态核验 |
| CLI | `xreach` | `which xreach` |
| CLI | `curl` | `which curl` |
| CLI | `ffmpeg` | `which ffmpeg` |
| Python 脚本 | `route_search.py` | 文件存在性 |
| Python 脚本 | `fxtwitter_search.py` | 文件存在性 |
| Python 脚本 | `anysearch_cli.py` | 文件存在性 + 子命令合约 |
| Python 脚本 | `x_known_url.py` | 文件存在性 |
| Python 脚本 | `wechat_mp_local.py` | 文件存在性 |
| 配置文件 | `runtime.conf` | 文件存在 + Command 字段 |
| 环境变量 | `ANYSEARCH_RUNTIME_CONFIG` | 环境变量检查 |
