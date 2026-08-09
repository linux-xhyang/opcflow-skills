#!/usr/bin/env python3
"""Check opcflow skill dependencies. Read-only, no network, no private content."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path


OPCFLOW_ROOT = Path(__file__).resolve().parents[2]

SKILLS: dict[str, dict] = {
    "unified-search": {
        "name": "opc-unified-search",
        "root": OPCFLOW_ROOT / "opc-unified-search",
    },
    "content-archive": {
        "name": "opc-content-archive",
        "root": OPCFLOW_ROOT / "opc-content-archive",
    },
    "anysearch": {
        "name": "opc-anysearch",
        "root": OPCFLOW_ROOT / "opc-anysearch",
    },
}

# -- helpers --

class Check:
    def __init__(self, key: str, label: str, install: str = "", skill: str | None = None) -> None:
        self.key = key
        self.label = label
        self.install = install
        self.skill = skill

    def run(self) -> dict:
        raise NotImplementedError


class WhichCheck(Check):
    def __init__(self, binary: str, label: str, install: str = "", skill: str | None = None, verify: tuple[str, ...] = ()) -> None:
        super().__init__(f"cli:{binary}", label, install, skill)
        self.binary = binary
        self.verify = verify

    def run(self) -> dict:
        path = shutil.which(self.binary)
        if not path:
            return {"status": "error", "message": f"{self.binary} 未安装", "install_hint": self.install}
        result: dict = {"status": "ok", "message": f"{self.binary} ({path})", "path": path}
        if self.verify:
            try:
                proc = subprocess.run(
                    [self.binary, *self.verify], check=False, text=True,
                    capture_output=True, timeout=10,
                )
                if proc.returncode == 0:
                    result["verify"] = "passed"
                else:
                    result["verify"] = "failed"
                    result["status"] = "warn"
                    result["message"] += f" (验证命令返回 {proc.returncode})"
            except (OSError, subprocess.SubprocessError) as exc:
                result["verify"] = "error"
                result["status"] = "warn"
                result["message"] += f" (验证失败: {exc})"
        return result


class ScriptCheck(Check):
    def __init__(self, relpath: str, label: str, skill: str, install: str = "") -> None:
        super().__init__(f"script:{relpath}", label, install, skill)
        self.skill_key = skill
        self.relpath = relpath

    def run(self) -> dict:
        info = SKILLS.get(self.skill_key)
        if not info:
            return {"status": "error", "message": f"未知 skill: {self.skill_key}"}
        path = info["root"] / self.relpath
        if path.is_file():
            return {"status": "ok", "message": f"{self.relpath} 存在", "path": str(path)}
        return {"status": "error", "message": f"{self.relpath} 缺失", "expected_path": str(path)}


class ConfigCheck(Check):
    def __init__(self, relpath: str, label: str, fields: tuple[str, ...], skill: str) -> None:
        super().__init__(f"config:{relpath}", label, "", skill)
        self.skill_key = skill
        self.relpath = relpath
        self.fields = fields

    def run(self) -> dict:
        info = SKILLS.get(self.skill_key)
        if not info:
            return {"status": "error", "message": f"未知 skill: {self.skill_key}"}
        path = info["root"] / self.relpath
        if not path.is_file():
            return {"status": "error", "message": f"{self.relpath} 缺失", "expected_path": str(path)}
        try:
            content = path.read_text(encoding="utf-8")
        except OSError as exc:
            return {"status": "error", "message": f"无法读取 {self.relpath}: {exc}"}
        missing = [f for f in self.fields if f not in content]
        if missing:
            return {"status": "warn", "message": f"{self.relpath} 存在但缺少字段: {', '.join(missing)}", "path": str(path)}
        return {"status": "ok", "message": f"{self.relpath} 配置完整", "path": str(path)}


class PyModuleCheck(Check):
    """Check if a Python module is importable by spawning an interpreter subprocess."""

    def __init__(self, module: str, label: str, install: str = "", skill: str | None = None) -> None:
        super().__init__(f"pymod:{module}", label, install, skill)
        self.module = module

    def run(self) -> dict:
        try:
            proc = subprocess.run(
                [sys.executable, "-c", f"import {self.module}"],
                check=False, text=True, capture_output=True, timeout=15,
            )
            if proc.returncode == 0:
                return {"status": "ok", "message": f"{self.module} 可导入"}
            return {
                "status": "error",
                "message": f"{self.module} 未安装 ({proc.stderr.strip()})",
                "install_hint": self.install,
            }
        except (OSError, subprocess.SubprocessError) as exc:
            return {"status": "error", "message": f"检查 {self.module} 失败: {exc}", "install_hint": self.install}


class EnvCheck(Check):
    def __init__(self, var: str, label: str, install: str = "") -> None:
        super().__init__(f"env:{var}", label, install, None)
        self.var = var

    def run(self) -> dict:
        value = os.environ.get(self.var)
        if value:
            return {"status": "ok", "message": f"{self.var}={value}"}
        return {"status": "warn", "message": f"{self.var} 未设置", "install_hint": self.install}


# -- checks registry --
CHECKS: list[Check] = [
    # CLI tools
    WhichCheck("python3", "Python 3", "需要 Python 3.10+", verify=("--version",)),
    WhichCheck("curl", "curl", "brew install curl 或 apt install curl", verify=("--version",)),
    WhichCheck("gh", "GitHub CLI", "brew install gh 或 apt install gh", skill="unified-search", verify=("--version",)),
    WhichCheck("opencli", "OpenCLI", "需要安装 OpenCLI 并配置子命令", skill="unified-search", verify=("--version",)),
    WhichCheck("bili", "Bili CLI", "pip install bili-cli 或 npm install -g bili", skill="unified-search"),
    WhichCheck("yt-dlp", "yt-dlp", "brew install yt-dlp 或 pip install yt-dlp", skill="unified-search", verify=("--version",)),
    WhichCheck("grok", "Grok CLI", "安装 Grok CLI 并完成 OAuth 登录", skill="unified-search"),
    WhichCheck("xreach", "xreach", "需要安装 xreach read-only GraphQL 客户端", skill="unified-search"),
    WhichCheck("ffmpeg", "FFmpeg", "brew install ffmpeg 或 apt install ffmpeg", skill="content-archive", verify=("-version",)),

    # Python modules
    PyModuleCheck("playwright", "Playwright Python 模块", "pip install playwright && python3 -m playwright install chromium", skill="content-archive"),

    # Scripts — unified-search
    ScriptCheck("scripts/route_search.py", "离线路由器", "unified-search"),
    ScriptCheck("scripts/fxtwitter_search.py", "FxTwitter 搜索适配器", "unified-search"),

    # Scripts — content-archive
    ScriptCheck("scripts/x_known_url.py", "X 已知 URL 读取器", "content-archive"),
    ScriptCheck("scripts/xiaohongshu_fetch.py", "小红书笔记抓取", "content-archive"),
    ScriptCheck("scripts/douyin_download.py", "抖音视频下载", "content-archive"),
    ScriptCheck("scripts/wechat_mp_local.py", "微信公众号本地客户端", "content-archive"),
    ScriptCheck("scripts/xiaoyuzhou_stepfun.py", "小宇宙 StepFun 下载", "content-archive"),
    ScriptCheck("scripts/xiaoyuzhou_opencli.py", "小宇宙 OpenCLI 适配器", "content-archive"),

    # Scripts — anysearch
    ScriptCheck("scripts/anysearch_cli.py", "AnySearch CLI", "anysearch"),

    # Config
    ConfigCheck("runtime.conf", "AnySearch 运行时配置", ("Command=",), "anysearch"),

    # Env
    EnvCheck("ANYSEARCH_RUNTIME_CONFIG", "AnySearch 配置文件路径"),
    EnvCheck("OPCFLOW_ROOT", "opcflow 仓库根目录"),
]


def report() -> dict:
    skills_result: dict = {}
    for key in SKILLS:
        skills_result[key] = {
            "name": SKILLS[key]["name"],
            "exists": SKILLS[key]["root"].is_dir(),
            "backends": {},
        }

    summary = {"ok": 0, "warn": 0, "error": 0}
    recommendations: list[str] = []

    for check in CHECKS:
        result = check.run()
        summary[result["status"]] += 1

        if check.skill and check.skill in skills_result:
            skills_result[check.skill]["backends"][check.key] = result
        else:
            shared = skills_result.setdefault("_shared", {"name": "共享依赖", "exists": True, "backends": {}})
            shared["backends"][check.key] = result

        if result["status"] != "ok" and check.install:
            recommendations.append(f"[{check.key}] {check.label}: {check.install}")

    return {
        "opcflow_version": "1.0",
        "opcflow_root": str(OPCFLOW_ROOT),
        "skills": skills_result,
        "summary": summary,
        "recommendations": recommendations,
    }


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="opcflow 技能栈依赖体检")
    parser.add_argument("--skill", choices=list(SKILLS.keys()), help="限定检查范围")
    parser.add_argument("--json", action="store_true", default=True, help="JSON 输出（默认）")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    data = report()

    if args.skill:
        data["skills"] = {args.skill: data["skills"][args.skill]}
        data["recommendations"] = [
            r for r in data["recommendations"]
            if any(c.key.startswith(f"cli:") or c.skill == args.skill for c in CHECKS if c.key in r)
        ]

    print(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True))
    return 0 if data["summary"]["error"] == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main())
