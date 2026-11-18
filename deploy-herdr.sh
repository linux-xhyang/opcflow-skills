#!/usr/bin/env bash
# deploy-herdr.sh — 部署 Herdr mods、layout、快捷键与 herdr-core 配置。
# 兼容 macOS 自带 bash 3.2 与 Linux bash。

set -euo pipefail

usage() {
  cat <<EOF
用法: $0 [选项]

  无选项            部署并切换到 emacs-main layout
  -n, --dry-run     只预览，不修改文件或切换 layout
  --no-switch       部署后不切换到 emacs-main layout
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
while [ "$#" -gt 0 ]; do
  case "$1" in
    -n|--dry-run) DRY_RUN=1 ;;
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
HERDR_CORE_SRC="$REPO_DIR/config/herdr-core"

HERDR_APP_DST="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
MODS_DST="${HERDR_MODS_DIR:-$HERDR_APP_DST/mods}"
LAYOUTS_DST="${HERDR_LAYOUTS_DIR:-$HERDR_APP_DST/layouts}"
HERDR_KEYS_DST="${HERDR_KEYS_FILE:-$HERDR_APP_DST/keys.json}"
HERDR_CORE_DST="${HERDR_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-core}"

step() { printf '\n==> %s\n' "$*"; }
done_() { printf '    [ok]   %s\n' "$*"; }
skip_() { printf '    [skip] %s\n' "$*"; }
warn() { printf '    [warn] %s\n' "$*"; }

do_mkdir() { if [ "$DRY_RUN" -eq 0 ]; then mkdir -p "$1"; else printf '    mkdir -p %s\n' "$1"; fi; }
do_rm() { if [ "$DRY_RUN" -eq 0 ]; then rm "$1"; else printf '    rm %s\n' "$1"; fi; }
do_ln() { if [ "$DRY_RUN" -eq 0 ]; then ln -s "$1" "$2"; else printf '    ln -s %s %s\n' "$1" "$2"; fi; }
do_cp() { if [ "$DRY_RUN" -eq 0 ]; then cp -R "$1" "$2"; else printf '    cp -R %s %s\n' "$1" "$2"; fi; }

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

step "部署 herdr-core 配置"
printf '    源:   %s\n    目标: %s\n' "$HERDR_CORE_SRC" "$HERDR_CORE_DST"
if [ -d "$HERDR_CORE_SRC" ]; then
  [ -d "$HERDR_CORE_DST" ] || do_mkdir "$HERDR_CORE_DST"
  for src in "$HERDR_CORE_SRC"/*; do
    [ -e "$src" ] || continue
    name="${src##*/}"
    do_cp "$src" "$HERDR_CORE_DST/"
    done_ "复制 $name"
  done
else
  warn "未找到 config/herdr-core"
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
