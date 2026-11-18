#!/usr/bin/env python3
"""Scan agent CLI session logs and print one JSON object: {"sessions": [...]}.

会话日志目录映射（与 herdr-core session_log.rs 一致）:
  traex  -> traecli app-server thread/list（逻辑会话，自动分页）
  claude -> ~/.claude/projects/<编码项目>/<uuid>.jsonl
  codex  -> ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl
  cursor -> ~/.cursor/projects
  grok   -> $GROK_HOME/sessions（默认 ~/.grok/sessions）
  pi     -> ~/.pi/agent/sessions

每行输出字段: cli, id, title(TRAE 名称优先，其余取首条用户消息), cwd,
mtime, path。只列最近 DAYS 天、最多 LIMIT 个。
"""
import json
import os
import selectors
import shutil
import stat
import subprocess
import sys
import time
import uuid

HOME = os.path.expanduser("~")
TRAE_HOME = os.path.expanduser(os.environ.get("TRAE_HOME", os.path.join(HOME, ".trae")))
DAYS = 90
LIMIT = 400
HEAD_BYTES = 131072  # 每个文件只读前 128KB 取标题

ROOTS = [
    ("traex", os.path.join(TRAE_HOME, "cli", "sessions"), 5),
    ("claude", os.path.join(HOME, ".claude", "projects"), 2),
    ("codex", os.path.join(HOME, ".codex", "sessions"), 5),
    ("cursor", os.path.join(HOME, ".cursor", "projects"), 2),
    ("grok", os.path.join(HOME, ".grok", "sessions"), 5),
    ("pi", os.path.join(HOME, ".pi", "agent", "sessions"), 4),
]


class TraeRpc:
    """Short-lived JSONL client for the standard app-server stdio transport."""

    def __init__(self, command, deadline):
        self.deadline = deadline
        self.sequence = 0
        self.buffer = b""
        self.stderr = b""
        self.process = subprocess.Popen(command, stdin=subprocess.PIPE,
                                        stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.selector.register(self.process.stderr, selectors.EVENT_READ)

    def send(self, message):
        self.process.stdin.write((json.dumps(message) + "\n").encode())
        self.process.stdin.flush()

    def request(self, method, params):
        self.sequence += 1
        request_id = self.sequence
        self.send({"id": request_id, "method": method, "params": params})
        while True:
            while b"\n" in self.buffer:
                line, self.buffer = self.buffer.split(b"\n", 1)
                if not line.strip():
                    continue
                message = json.loads(line)
                if message.get("method"):
                    if "id" in message:
                        self.send({"id": message["id"], "error": {
                            "code": -32601, "message": "Sessions is a read-only list client"}})
                    continue
                if message.get("id") != request_id:
                    continue
                if "error" in message:
                    raise ValueError(message["error"].get("message", "TRAE RPC failed"))
                return message["result"]
            remaining = self.deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("TRAE 会话列表读取超时")
            if not self.selector.get_map():
                raise RuntimeError("TRAE app-server 已退出: " + self.stderr.decode(errors="replace")[-1000:])
            for key, _ in self.selector.select(remaining):
                data = os.read(key.fileobj.fileno(), 65536)
                if not data:
                    self.selector.unregister(key.fileobj)
                elif key.fileobj is self.process.stdout:
                    self.buffer += data
                else:
                    self.stderr = (self.stderr + data)[-4096:]

    def close(self):
        self.selector.close()
        try:
            self.process.stdin.close()
        except OSError:
            pass
        try:
            self.process.wait(timeout=0.5)
        except subprocess.TimeoutExpired:
            self.process.terminate()
            try:
                self.process.wait(timeout=1)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait()
        self.process.stdout.close()
        self.process.stderr.close()


def trae_executable():
    executable = shutil.which("traecli")
    if not executable:
        raise ValueError("找不到 traecli；TRAE 会话列表需要标准 app-server 接口")
    return executable


def connect_trae(deadline):
    client = TraeRpc([trae_executable(), "app-server", "--stdio"], deadline)
    try:
        client.request("initialize", {
            "clientInfo": {"name": "herdr_sessions", "version": "1.0"},
            "capabilities": {"experimentalApi": True},
        })
        client.send({"method": "initialized"})
        return client
    except (OSError, ValueError, RuntimeError, TimeoutError):
        client.close()
        raise


def list_trae_sessions(archived=False):
    """List logical threads, never physical rollout fragments."""
    client = connect_trae(time.monotonic() + 20)
    rows = {}
    cursor = None
    seen_cursors = set()
    cutoff = time.time() - DAYS * 86400
    try:
        while len(rows) < LIMIT:
            params = {"archived": archived, "limit": 50,
                      "sortKey": "updated_at", "sortDirection": "desc",
                      "useStateDbOnly": True}
            if cursor:
                params["cursor"] = cursor
            page = client.request("thread/list", params)
            old = False
            for thread in page["data"]:
                updated = thread.get("updatedAt", 0)
                if updated < cutoff:
                    old = True
                    continue
                session_id = thread["id"]
                rows[session_id] = {
                    "cli": "traex", "id": session_id,
                    "title": (thread.get("name") or thread.get("preview") or session_id)[:160],
                    "cwd": thread.get("cwd") or "", "mtime": updated,
                    "path": thread.get("path") or "", "archived": archived,
                }
            cursor = page.get("nextCursor")
            if old or not cursor:
                break
            if cursor in seen_cursors:
                raise ValueError("TRAE 会话列表返回重复分页游标")
            seen_cursors.add(cursor)
    finally:
        client.close()
    return sorted(rows.values(), key=lambda row: -row["mtime"])[:LIMIT]


def manage_trae_session(action, session_id):
    if action not in {"delete", "archive", "unarchive"}:
        raise ValueError("未知 TRAE 会话操作")
    # Do not accept a legacy rollout path or let an ID become a CLI flag.
    try:
        uuid.UUID(session_id)
    except ValueError:
        raise ValueError("TRAE 操作需要逻辑会话 UUID，不能使用历史文件路径") from None
    command = [trae_executable(), action, session_id]
    if action == "delete":
        command.append("--force")  # UI has already confirmed; dependency checks still apply.
    result = subprocess.run(command, capture_output=True, text=True, timeout=20)
    if result.returncode:
        raise ValueError((result.stderr or result.stdout or "TRAE 会话操作失败").strip())
    return {"action": action, "id": session_id}


def delete_session(cli, path, roots=None):
    """把受管会话日志移入对应根目录的 .deleted，拒绝任意路径删除。"""
    if cli == "traex":
        raise ValueError("TRAE 会话不能按历史文件删除；请使用逻辑会话 UUID")
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


def scan(archived=False):
    now = time.time()
    out = []
    warnings = []
    if any(cli == "traex" for cli, _root, _depth in ROOTS):
        try:
            out.extend(list_trae_sessions(archived))
        except (OSError, ValueError, RuntimeError, TimeoutError) as error:
            warnings.append(f"TRAE 会话列表不可用：{error}")
    for cli, root, depth in ROOTS:
        if cli == "traex" or archived:
            continue
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
                        head = f.read(HEAD_BYTES)
                except OSError:
                    continue
                session_id = fn[:-6]
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
    print(json.dumps({"sessions": out[:LIMIT], "warnings": warnings}, ensure_ascii=False))


def main(argv):
    if not argv:
        scan()
        return 0
    if argv == ["--archived"]:
        scan(archived=True)
        return 0
    if len(argv) == 3 and argv[0] in {"--delete", "--archive", "--unarchive"}:
        try:
            if argv[1] == "traex":
                result = manage_trae_session(argv[0][2:], argv[2])
            elif argv[0] == "--delete":
                result = {"deleted_to": delete_session(argv[1], argv[2])}
            else:
                raise ValueError("归档仅支持 TRAE 会话")
        except (OSError, ValueError, subprocess.TimeoutExpired) as error:
            print(str(error), file=sys.stderr)
            return 1
        print(json.dumps(result, ensure_ascii=False))
        return 0
    print("用法: scan.py [--archived | --delete <cli> <path-or-id> | --archive/--unarchive traex <uuid>]", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
