#!/usr/bin/env bash
# deploy-skills.sh — 部署仓库内 skills，并桥接给 Claude Code。
# 兼容 macOS 自带 bash 3.2 与 Linux bash。

set -euo pipefail

usage() {
  cat <<EOF
用法: $0 [选项]

  无选项            部署（幂等，可重复执行）
  -n, --dry-run     只预览，不修改文件
  --no-claude       不向 Claude Code 的 skill 目录建立桥接
  -h, --help        显示本帮助

目标目录:
  通用 skills       ${SKILLS_DIR:-~/.agents/skills}
  Claude Code       ${CLAUDE_SKILLS_DIR:-~/.claude/skills}
EOF
}

DRY_RUN=0
NO_CLAUDE=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -n|--dry-run) DRY_RUN=1 ;;
    --no-claude)  NO_CLAUDE=1 ;;
    -h|--help)    usage; exit 0 ;;
    *)            printf '未知参数: %s\n\n' "$1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

REPO_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_SRC="$REPO_DIR/skills"
SKILLS_DST="${SKILLS_DIR:-$HOME/.agents/skills}"
CLAUDE_DST="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"

step() { printf '\n==> %s\n' "$*"; }
done_() { printf '    [ok]   %s\n' "$*"; }
skip_() { printf '    [skip] %s\n' "$*"; }
warn() { printf '    [warn] %s\n' "$*"; }

do_mkdir() { if [ "$DRY_RUN" -eq 0 ]; then mkdir -p "$1"; else printf '    mkdir -p %s\n' "$1"; fi; }
do_rm() { if [ "$DRY_RUN" -eq 0 ]; then rm "$1"; else printf '    rm %s\n' "$1"; fi; }
do_ln() { if [ "$DRY_RUN" -eq 0 ]; then ln -s "$1" "$2"; else printf '    ln -s %s %s\n' "$1" "$2"; fi; }

repoint() {
  local dst="$1" target="$2"
  [ -L "$dst" ] || return 1
  if [ "$(readlink "$dst")" = "$target" ]; then return 0; fi
  do_rm "$dst"
  do_ln "$target" "$dst"
  return 2
}

deploy_to_dir() {
  local src_dir="$1" dst_dir="$2" target_base="$3" label="$4"
  local src name dst target
  [ -d "$dst_dir" ] || do_mkdir "$dst_dir"
  for src in "$src_dir"/*/; do
    [ -d "$src" ] || continue
    name="${src%/}"; name="${name##*/}"
    dst="$dst_dir/$name"
    target="$target_base/$name"
    if [ -L "$dst" ]; then
      if repoint "$dst" "$target"; then
        skip_ "$label: $name 已链接"
      else
        done_ "$label: 重新链接 $name -> $dst"
      fi
    elif [ -e "$dst" ]; then
      warn "$label: 跳过 $name：目标已存在且不是软链接（$dst）"
    else
      do_ln "$target" "$dst"
      done_ "$label: 链接 $name -> $dst"
    fi
  done
}

step "部署 skills 到通用目录"
printf '    源:   %s\n    目标: %s\n' "$SKILLS_SRC" "$SKILLS_DST"
if [ -d "$SKILLS_SRC" ]; then
  for src in "$SKILLS_SRC"/*/; do
    [ -d "$src" ] || continue
    [ -f "$src/SKILL.md" ] || warn "${src%/} 缺少 SKILL.md"
  done
  deploy_to_dir "$SKILLS_SRC" "$SKILLS_DST" "$SKILLS_SRC" "通用"
else
  warn "未找到 skills 目录"
fi

step "桥接通用 skills 到 Claude Code"
printf '    源:   %s\n    目标: %s\n' "$SKILLS_DST" "$CLAUDE_DST"
if [ "$NO_CLAUDE" -eq 1 ]; then
  skip_ "已用 --no-claude 跳过"
elif [ ! -d "$SKILLS_SRC" ]; then
  warn "未找到 skills 目录"
elif [ "$CLAUDE_DST" = "$SKILLS_DST" ]; then
  skip_ "Claude 目录与通用目录相同"
else
  deploy_to_dir "$SKILLS_SRC" "$CLAUDE_DST" "$SKILLS_DST" "Claude"
fi

if [ "$DRY_RUN" -eq 1 ]; then
  printf '\nSkill deploy 预览完成，未修改文件。\n'
else
  printf '\nSkill deploy 完成。\n'
fi
