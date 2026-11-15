#!/usr/bin/env python3
"""Scan agent CLI session logs and print one JSON object: {"sessions": [...]}.

会话日志目录映射（与 herdr-core session_log.rs 一致）:
  claude -> ~/.claude/projects/<编码项目>/<uuid>.jsonl
  codex  -> ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl
  cursor -> ~/.cursor/projects
  grok   -> $GROK_HOME/sessions（默认 ~/.grok/sessions）
  pi     -> ~/.pi/agent/sessions

每行输出字段: cli, id, title(首条用户消息), cwd(从 jsonl 行内读取，用于恢复),
mtime, path。只列最近 DAYS 天、最多 LIMIT 个。
"""
import json
import os
import time

HOME = os.path.expanduser("~")
DAYS = 90
LIMIT = 400
HEAD_BYTES = 131072  # 每个文件只读前 128KB 取标题

ROOTS = [
    ("claude", os.path.join(HOME, ".claude", "projects"), 2),
    ("codex", os.path.join(HOME, ".codex", "sessions"), 5),
    ("cursor", os.path.join(HOME, ".cursor", "projects"), 2),
    ("grok", os.path.join(HOME, ".grok", "sessions"), 5),
    ("pi", os.path.join(HOME, ".pi", "agent", "sessions"), 4),
]


def first_user_title(head: bytes):
    """从 jsonl 头部提取: 标题 = 首条 user 消息文本; cwd = 任意行的 cwd 字段。"""
    title = None
    cwd = None
    for line in head.split(b"\n"):
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            break  # 文件被截断或不是 jsonl，到此为止
        c = d.get("cwd")
        if cwd is None and isinstance(c, str) and c:
            cwd = c
        if title is None and d.get("type") == "user":
            m = d.get("message") or {}
            content = m.get("content")
            if isinstance(content, str):
                title = content
            elif isinstance(content, list):
                for part in content:
                    if isinstance(part, dict) and isinstance(part.get("text"), str) and part["text"].strip():
                        title = part["text"]
                        break
            if title is None and isinstance(m.get("text"), str):
                title = m["text"]
        if title is not None and cwd is not None:
            break
    return title, cwd


def scan():
    now = time.time()
    out = []
    for cli, root, depth in ROOTS:
        if not os.path.isdir(root):
            continue
        base_depth = root.rstrip(os.sep).count(os.sep)
        for dirpath, dirs, files in os.walk(root):
            if dirpath.count(os.sep) - base_depth >= depth:
                dirs[:] = []
                continue
            for fn in files:
                if not fn.endswith(".jsonl"):
                    continue
                path = os.path.join(dirpath, fn)
                try:
                    st = os.stat(path)
                except OSError:
                    continue
                if now - st.st_mtime > DAYS * 86400 or st.st_size == 0:
                    continue
                try:
                    with open(path, "rb") as f:
                        head = f.read(HEAD_BYTES)
                except OSError:
                    continue
                title, cwd = first_user_title(head)
                out.append({
                    "cli": cli,
                    "id": fn[:-6],  # 去掉 .jsonl
                    "title": (title or fn[:-6])[:160],
                    "cwd": cwd or "",
                    "mtime": int(st.st_mtime),
                    "path": path,
                })
                if len(out) >= LIMIT:
                    break
            if len(out) >= LIMIT:
                break
        if len(out) >= LIMIT:
            break
    out.sort(key=lambda x: -x["mtime"])
    print(json.dumps({"sessions": out}, ensure_ascii=False))


if __name__ == "__main__":
    scan()
