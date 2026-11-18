#!/usr/bin/env bash
# deploy-herdr.sh — 部署 Herdr app 子系统与事务化 herdr-flow release。
# 兼容 macOS 自带 bash 3.2 与 Linux bash。

set -euo pipefail

usage() {
  cat <<EOF
用法: $0 [选项]

  无选项            部署并切换到 emacs-main layout
  -n, --dry-run     只预览，不修改文件或切换 layout
  --allow-dirty     显式部署带独立身份的 development release
  --no-switch       部署后不切换到 emacs-main layout
  rollback TARGET   回滚到精确 retained receipt 或 release
  recover --complete OPERATION_ID
  recover --rollback OPERATION_ID
                    显式完成或回退已激活的中断事务
  doctor            只读检查部署状态
  diagnose OPERATION_ID
                    只读解释一个部署事务及恢复选项
  gc [PLAN_DIGEST]  无 digest 时只生成计划；有 digest 时执行该计划
  support-bundle OUTPUT
                    导出严格脱敏的部署支持包
  -h, --help        显示本帮助

目标目录:
  Herdr app         ${HERDR_APP_HOME:-~/.config/herdr-app}
  Herdr mods        ${HERDR_MODS_DIR:-<Herdr app>/mods}
  Herdr layouts     ${HERDR_LAYOUTS_DIR:-<Herdr app>/layouts}
  Herdr core        ${HERDR_CONFIG_DIR:-${XDG_CONFIG_HOME:-~/.config}/herdr-core}
EOF
}

DRY_RUN=0
NO_SWITCH=0
ALLOW_DIRTY=0
FLOW_ACTION=apply
FLOW_ARGUMENT_1=
FLOW_ARGUMENT_2=
case "${1:-}" in
  rollback)
    [ "$#" -eq 2 ] || { usage >&2; exit 2; }
    FLOW_ACTION=rollback
    FLOW_ARGUMENT_1="$2"
    shift 2
    ;;
  recover)
    [ "$#" -eq 3 ] || { usage >&2; exit 2; }
    case "$2" in
      --complete|--rollback) FLOW_ARGUMENT_1="$2" ;;
      *) usage >&2; exit 2 ;;
    esac
    FLOW_ACTION=recover
    FLOW_ARGUMENT_2="$3"
    shift 3
    ;;
  doctor)
    [ "$#" -eq 1 ] || { usage >&2; exit 2; }
    FLOW_ACTION=doctor
    shift
    ;;
  diagnose)
    [ "$#" -eq 2 ] || { usage >&2; exit 2; }
    FLOW_ACTION=diagnose
    FLOW_ARGUMENT_1="$2"
    shift 2
    ;;
  gc)
    [ "$#" -le 2 ] || { usage >&2; exit 2; }
    FLOW_ACTION=gc
    FLOW_ARGUMENT_1="${2:-}"
    shift "$#"
    ;;
  support-bundle)
    [ "$#" -eq 2 ] || { usage >&2; exit 2; }
    FLOW_ACTION=support-bundle
    FLOW_ARGUMENT_1="$2"
    shift 2
    ;;
esac
while [ "$#" -gt 0 ]; do
  case "$1" in
    -n|--dry-run) DRY_RUN=1 ;;
    --allow-dirty) ALLOW_DIRTY=1 ;;
    --no-switch)  NO_SWITCH=1 ;;
    -h|--help)    usage; exit 0 ;;
    *)            printf '未知参数: %s\n\n' "$1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

REPO_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODS_SRC="$REPO_DIR/config/herdr-mod"
LAYOUTS_SRC="$REPO_DIR/config/herdr-layout"
HERDR_APP_SRC="$REPO_DIR/config/herdr-app"

HERDR_APP_DST="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
MODS_DST="${HERDR_MODS_DIR:-$HERDR_APP_DST/mods}"
LAYOUTS_DST="${HERDR_LAYOUTS_DIR:-$HERDR_APP_DST/layouts}"
HERDR_KEYS_DST="${HERDR_KEYS_FILE:-$HERDR_APP_DST/keys.json}"
HERDR_PROGRAMS_DST="${HERDR_PROGRAMS_FILE:-$HERDR_APP_DST/programs.json}"

step() { printf '\n==> %s\n' "$*"; }
done_() { printf '    [ok]   %s\n' "$*"; }
skip_() { printf '    [skip] %s\n' "$*"; }
warn() { printf '    [warn] %s\n' "$*"; }

do_mkdir() { if [ "$DRY_RUN" -eq 0 ]; then mkdir -p "$1"; else printf '    mkdir -p %s\n' "$1"; fi; }
do_rm() { if [ "$DRY_RUN" -eq 0 ]; then rm "$1"; else printf '    rm %s\n' "$1"; fi; }
do_ln() { if [ "$DRY_RUN" -eq 0 ]; then ln -s "$1" "$2"; else printf '    ln -s %s %s\n' "$1" "$2"; fi; }

flow_cli() {
  PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$REPO_DIR/src" \
    python3 -m herdr_flow deploy "$@"
}

if ! command -v python3 >/dev/null 2>&1; then
  printf 'herdr-flow 部署需要 Python 3.11 或 3.12。\n' >&2
  exit 10
fi

if [ "$FLOW_ACTION" != apply ]; then
  case "$FLOW_ACTION" in
    rollback) flow_cli rollback "$FLOW_ARGUMENT_1" --json ;;
    recover) flow_cli recover "$FLOW_ARGUMENT_2" "$FLOW_ARGUMENT_1" --json ;;
    doctor) flow_cli doctor --json ;;
    diagnose) flow_cli diagnose "$FLOW_ARGUMENT_1" --json ;;
    gc)
      if [ -n "$FLOW_ARGUMENT_1" ]; then
        flow_cli gc --apply-plan "$FLOW_ARGUMENT_1" --json
      else
        flow_cli gc --json
      fi
      ;;
    support-bundle) flow_cli support-bundle "$FLOW_ARGUMENT_1" --json ;;
  esac
  exit $?
fi

flow_apply_arguments=""
if [ "$ALLOW_DIRTY" -eq 1 ]; then
  flow_apply_arguments="--allow-dirty"
fi

if [ "$DRY_RUN" -eq 0 ]; then
  step "herdr-flow 只读 preflight"
  # shellcheck disable=SC2086
  flow_cli apply --repository "$REPO_DIR" --dry-run $flow_apply_arguments --json
  done_ "herdr-flow preflight 通过"
fi

link_path() {
  local target="$1" dst="$2" label="$3"
  if [ -L "$dst" ]; then
    if [ "$(readlink "$dst")" = "$target" ]; then
      skip_ "$label 已链接"
      return
    fi
    do_rm "$dst"
    do_ln "$target" "$dst"
    done_ "$label 重新链接 -> $dst"
  elif [ -e "$dst" ]; then
    warn "跳过 $label：目标已存在且不是软链接（$dst）"
  else
    do_ln "$target" "$dst"
    done_ "$label -> $dst"
  fi
}

step "部署 Herdr mods"
printf '    源:   %s\n    目标: %s\n' "$MODS_SRC" "$MODS_DST"
if [ -d "$MODS_SRC" ]; then
  [ -d "$MODS_DST" ] || do_mkdir "$MODS_DST"
  for src in "$MODS_SRC"/*/; do
    [ -d "$src" ] || continue
    name="${src%/}"; name="${name##*/}"
    [ -f "$src/mod.json" ] || warn "$name 缺少 mod.json"
    link_path "$MODS_SRC/$name" "$MODS_DST/$name" "mod: $name"
  done
else
  warn "未找到 config/herdr-mod"
fi

step "部署 Herdr layouts"
printf '    源:   %s\n    目标: %s\n' "$LAYOUTS_SRC" "$LAYOUTS_DST"
if [ -d "$LAYOUTS_SRC" ]; then
  [ -d "$LAYOUTS_DST" ] || do_mkdir "$LAYOUTS_DST"
  for src in "$LAYOUTS_SRC"/*.json; do
    [ -f "$src" ] || continue
    name="${src##*/}"
    link_path "$src" "$LAYOUTS_DST/$name" "layout: ${name%.json}"
  done
else
  warn "未找到 config/herdr-layout"
fi

step "合并 Herdr 快捷键"
keys_src="$HERDR_APP_SRC/keys.json"
printf '    源:   %s\n    目标: %s\n' "$keys_src" "$HERDR_KEYS_DST"
if [ ! -f "$keys_src" ]; then
  warn "未找到 config/herdr-app/keys.json"
elif [ ! -f "$HERDR_KEYS_DST" ]; then
  warn "未找到 $HERDR_KEYS_DST；请先启动一次 herdr-app"
elif ! command -v python3 >/dev/null 2>&1; then
  warn "未找到 python3，无法安全合并 keys.json"
elif [ "$DRY_RUN" -eq 1 ]; then
  printf '    merge-json %s -> %s（只补缺失项，保留冲突）\n' "$keys_src" "$HERDR_KEYS_DST"
else
  python3 - "$keys_src" "$HERDR_KEYS_DST" <<'PY'
import json
import os
import shutil
import stat
import sys
import tempfile

src_path, dst_path = sys.argv[1:]
with open(src_path, encoding="utf-8") as f:
    source = json.load(f)
with open(dst_path, encoding="utf-8") as f:
    target = json.load(f)

added = []
conflicts = []

def merge_missing(dst, src, path=()):
    for key, value in src.items():
        key_path = path + (key,)
        if key not in dst:
            dst[key] = value
            added.append(".".join(key_path))
        elif isinstance(dst[key], dict) and isinstance(value, dict):
            merge_missing(dst[key], value, key_path)
        elif dst[key] != value:
            conflicts.append(".".join(key_path))

merge_missing(target, source)
if added:
    backup_path = dst_path + ".opcflow-backup"
    shutil.copy2(dst_path, backup_path)
    dst_dir = os.path.dirname(dst_path) or "."
    fd, temp_path = tempfile.mkstemp(prefix=".keys.json.", dir=dst_dir)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(target, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.chmod(temp_path, stat.S_IMODE(os.stat(dst_path).st_mode))
        os.replace(temp_path, dst_path)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)
    print("    [ok]   新增快捷键: " + ", ".join(added))
else:
    print("    [skip] 快捷键配置已存在")
for key_path in conflicts:
    print("    [warn] 保留已有冲突配置: " + key_path)
PY
fi

step "合并 Herdr program 配置"
programs_src="$HERDR_APP_SRC/programs.json"
printf '    源:   %s\n    目标: %s\n' "$programs_src" "$HERDR_PROGRAMS_DST"
if [ ! -f "$programs_src" ]; then
  warn "未找到 config/herdr-app/programs.json"
elif [ "$DRY_RUN" -eq 1 ]; then
  printf '    merge-json %s -> %s（只补缺失项，保留冲突）\n' "$programs_src" "$HERDR_PROGRAMS_DST"
elif ! command -v python3 >/dev/null 2>&1; then
  warn "未找到 python3，无法安全合并 programs.json"
else
  python3 - "$programs_src" "$HERDR_PROGRAMS_DST" <<'PY'
import json
import os
import stat
import sys
import tempfile

src_path, dst_path = sys.argv[1:]
with open(src_path, encoding="utf-8") as f:
    source = json.load(f)
try:
    with open(dst_path, encoding="utf-8") as f:
        target = json.load(f)
except FileNotFoundError:
    target = {}

if not isinstance(source, dict) or not isinstance(target, dict):
    raise SystemExit("programs.json must contain a JSON object")

added = []
conflicts = []

def merge_missing(dst, src, path=()):
    for key, value in src.items():
        key_path = path + (key,)
        if key not in dst:
            dst[key] = value
            added.append(".".join(key_path))
        elif isinstance(dst[key], dict) and isinstance(value, dict):
            merge_missing(dst[key], value, key_path)
        elif dst[key] != value:
            conflicts.append(".".join(key_path))

merge_missing(target, source)
if added:
    dst_dir = os.path.dirname(dst_path) or "."
    os.makedirs(dst_dir, exist_ok=True)
    fd, temp_path = tempfile.mkstemp(prefix=".programs.json.", dir=dst_dir)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(target, f, ensure_ascii=False, indent=2)
            f.write("\n")
        os.chmod(temp_path, stat.S_IMODE(os.stat(dst_path).st_mode) if os.path.exists(dst_path) else 0o600)
        os.replace(temp_path, dst_path)
    finally:
        if os.path.exists(temp_path):
            os.unlink(temp_path)
    print("    [ok]   新增 program 配置: " + ", ".join(added))
else:
    print("    [skip] program 配置已存在")
for key_path in conflicts:
    print("    [warn] 保留已有冲突配置: " + key_path)
PY
fi

step "部署 herdr-flow release 与受管 Herdr templates"
if [ "$DRY_RUN" -eq 1 ]; then
  # shellcheck disable=SC2086
  flow_cli apply --repository "$REPO_DIR" --dry-run $flow_apply_arguments --json
  done_ "事务部署预览完成（零写入）"
else
  # shellcheck disable=SC2086
  flow_cli apply --repository "$REPO_DIR" $flow_apply_arguments --json
  done_ "release 已激活；如 Herdr Core 已运行，请手工 reload/restart"
fi

step "切换到 emacs-main layout"
if [ "$NO_SWITCH" -eq 1 ]; then
  skip_ "已用 --no-switch 跳过"
elif [ "$DRY_RUN" -eq 1 ]; then
  printf '    herdr-app do layout.switch %s\n' "'{\"name\":\"emacs-main\"}'"
elif ! command -v herdr-app >/dev/null 2>&1; then
  warn "未找到 herdr-app；部署已完成，请稍后手动切换到 emacs-main"
elif herdr-app do layout.switch '{"name":"emacs-main"}'; then
  done_ "已切换到 emacs-main"
else
  warn "layout 切换失败；可在 Herdr 中手动选择 emacs-main"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  printf '\nHerdr deploy 预览完成，未修改文件。\n'
else
  printf '\nHerdr deploy 完成。\n'
fi
