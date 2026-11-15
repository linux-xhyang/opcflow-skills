#!/usr/bin/env python3
"""Scan agent CLI session logs and print one JSON object: {"sessions": [...]}.

会话日志目录映射（与 herdr-core session_log.rs 一致）:
  traex  -> $TRAE_HOME/cli/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl
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
import re
import stat
import sys
import time

HOME = os.path.expanduser("~")
TRAE_HOME = os.path.expanduser(os.environ.get("TRAE_HOME", os.path.join(HOME, ".trae")))
DAYS = 90
LIMIT = 400
HEAD_BYTES = 131072  # 每个文件只读前 128KB 取标题
TRAE_META_BYTES = 1048576  # 旧版 TraeX session_meta 含完整指令，首行可达数百 KB

ROOTS = [
    ("traex", os.path.join(TRAE_HOME, "cli", "sessions"), 5),
    ("claude", os.path.join(HOME, ".claude", "projects"), 2),
    ("codex", os.path.join(HOME, ".codex", "sessions"), 5),
    ("cursor", os.path.join(HOME, ".cursor", "projects"), 2),
    ("grok", os.path.join(HOME, ".grok", "sessions"), 5),
    ("pi", os.path.join(HOME, ".pi", "agent", "sessions"), 4),
]


def delete_session(cli, path, roots=None):
    """把受管会话日志移入对应根目录的 .deleted，拒绝任意路径删除。"""
    if roots is None:
        roots = ROOTS
    roots_by_cli = {name: root for name, root, _depth in roots}
    root = roots_by_cli.get(cli)
    if root is None:
        raise ValueError(f"未知 CLI: {cli}")

    candidate = os.path.abspath(os.path.expanduser(path))
    root = os.path.realpath(os.path.expanduser(root))
    real_candidate = os.path.realpath(candidate)
    try:
        inside_root = os.path.commonpath([root, real_candidate]) == root
    except ValueError:
        inside_root = False
    if not inside_root:
        raise ValueError("拒绝删除会话根目录之外的文件")
    if not candidate.endswith(".jsonl"):
        raise ValueError("只允许删除 .jsonl 会话日志")

    try:
        mode = os.lstat(candidate).st_mode
    except FileNotFoundError:
        raise ValueError("会话日志不存在") from None
    if not stat.S_ISREG(mode):
        raise ValueError("只允许删除普通会话日志文件")

    deleted_dir = os.path.join(root, ".deleted")
    try:
        os.mkdir(deleted_dir, mode=0o700)
    except FileExistsError:
        pass
    if not stat.S_ISDIR(os.lstat(deleted_dir).st_mode):
        raise ValueError("会话回收目录不是普通目录")
    deleted_name = f"{os.path.basename(candidate)}.deleted-{time.time_ns()}"
    deleted_path = os.path.join(deleted_dir, deleted_name)
    os.rename(candidate, deleted_path)
    return deleted_path


def message_text(content):
    """从字符串或 message content 数组提取文本。"""
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return None
    parts = []
    for part in content:
        if not isinstance(part, dict):
            continue
        text = part.get("text")
        if isinstance(text, str) and text.strip():
            parts.append(text)
    return "\n".join(parts) if parts else None


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
            title = message_text(m.get("content"))
            if title is None and isinstance(m.get("text"), str):
                title = m["text"]
        if title is not None and cwd is not None:
            break
    return title, cwd


def traex_head_metadata(head: bytes):
    """提取 TraeX rollout 的真实 session id、cwd、首条用户输入和线程类型。"""
    session_id = None
    cwd = None
    title = None
    is_subagent = False
    for line in head.split(b"\n"):
        line = line.strip()
        if not line:
            continue
        try:
            d = json.loads(line)
        except Exception:
            break
        payload = d.get("payload")
        if not isinstance(payload, dict):
            continue
        if d.get("type") == "session_meta":
            value = payload.get("id") or payload.get("session_id")
            if isinstance(value, str) and value:
                session_id = value
            value = payload.get("cwd")
            if isinstance(value, str) and value:
                cwd = value
            source = payload.get("source")
            is_subagent = payload.get("thread_source") == "subagent" or (
                isinstance(source, dict) and "subagent" in source
            )
        elif (
            title is None
            and d.get("type") == "response_item"
            and payload.get("type") == "message"
            and payload.get("role") == "user"
            and isinstance(d.get("metadata"), dict)
            and d["metadata"].get("user_input_order") == 0
        ):
            title = message_text(payload.get("content"))
    return title, cwd, session_id, is_subagent


def load_traex_titles(trae_home=TRAE_HOME):
    """从轻量 history.jsonl 建立 session id -> 首条用户输入索引。"""
    titles = {}
    path = os.path.join(trae_home, "cli", "history.jsonl")
    try:
        f = open(path, encoding="utf-8")
    except OSError:
        return titles
    with f:
        for line in f:
            try:
                item = json.loads(line)
            except Exception:
                continue
            session_id = item.get("session_id")
            text = item.get("text")
            if (
                isinstance(session_id, str)
                and session_id
                and session_id not in titles
                and isinstance(text, str)
                and text.strip()
            ):
                titles[session_id] = text.strip()
    return titles


def traex_id_from_filename(filename):
    """metadata 不可读时，从 rollout 文件名末尾提取可用于 resume 的 UUID。"""
    match = re.search(
        r"([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$",
        filename,
    )
    return match.group(1) if match else filename[:-6]


def scan():
    now = time.time()
    out = []
    traex_titles = load_traex_titles()
    for cli, root, depth in ROOTS:
        if not os.path.isdir(root):
            continue
        base_depth = root.rstrip(os.sep).count(os.sep)
        for dirpath, dirs, files in os.walk(root):
            dirs[:] = [name for name in dirs if name != ".deleted"]
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
                        if cli == "traex":
                            # TraeX 的 session_meta 总在首行；旧版本会把完整指令放进去，
                            # 先完整读取该行，再只取后续 128KB 寻找首条用户输入。
                            head = f.readline(TRAE_META_BYTES) + f.read(HEAD_BYTES)
                        else:
                            head = f.read(HEAD_BYTES)
                except OSError:
                    continue
                session_id = traex_id_from_filename(fn) if cli == "traex" else fn[:-6]
                if cli == "traex":
                    title, cwd, meta_id, is_subagent = traex_head_metadata(head)
                    if is_subagent:
                        continue
                    if meta_id:
                        session_id = meta_id
                    title = traex_titles.get(session_id) or title
                else:
                    title, cwd = first_user_title(head)
                out.append({
                    "cli": cli,
                    "id": session_id,
                    "title": (title or session_id)[:160],
                    "cwd": cwd or "",
                    "mtime": int(st.st_mtime),
                    "path": path,
                })
    out.sort(key=lambda x: -x["mtime"])
    print(json.dumps({"sessions": out[:LIMIT]}, ensure_ascii=False))


def main(argv):
    if not argv:
        scan()
        return 0
    if len(argv) == 3 and argv[0] == "--delete":
        try:
            deleted_path = delete_session(argv[1], argv[2])
        except (OSError, ValueError) as error:
            print(str(error), file=sys.stderr)
            return 1
        print(json.dumps({"deleted_to": deleted_path}, ensure_ascii=False))
        return 0
    print("用法: scan.py [--delete <cli> <session.jsonl>]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
