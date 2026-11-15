#!/usr/bin/env bash
# deploy.sh — 部署 opcflow-skills 到本机（兼容 macOS 自带 bash 3.2 与 Linux bash）
#
# 部署内容:
#   1. skills/           软链接到通用 skill 目录（默认 ~/.agents/skills，
#                        可被任意 agent 读取，不绑定特定工具）
#   2. 通用目录中的 skill 桥接到 ~/.claude/skills，供 Claude Code 加载
#   3. config/herdr-core 复制到 herdr-core 配置目录
#                        默认: ${XDG_CONFIG_HOME:-~/.config}/herdr-core

set -euo pipefail

usage() {
  cat <<EOF
用法: $0 [选项]

  无选项            部署（幂等，可重复执行）
  -n, --dry-run     只预览将要执行的操作，不修改任何文件
  --no-claude       不向 Claude Code 的 skill 目录建立桥接
  -h, --help        显示本帮助

部署内容:
  1. skills/*           软链接到通用 skill 目录
                         默认: ~/.agents/skills（不绑定任何工具）
                         覆盖: 环境变量 SKILLS_DIR
  2. Claude 桥接         通用目录中的 skill 软链接到 ~/.claude/skills，
                         供 Claude Code 加载；--no-claude 可跳过
                         覆盖: 环境变量 CLAUDE_SKILLS_DIR
  3. config/herdr-core  复制到 herdr-core 配置目录
                         默认: \${XDG_CONFIG_HOME:-~/.config}/herdr-core
                         覆盖: 环境变量 HERDR_CONFIG_DIR

兼容 macOS（自带 bash 3.2）与 Linux。
EOF
}

DRY_RUN=0
NO_CLAUDE=0
case "${1:-}" in
  "")                ;;
  -n|--dry-run)      DRY_RUN=1 ;;
  --no-claude)       NO_CLAUDE=1 ;;
  -h|--help)         usage; exit 0 ;;
  *)                 printf '未知参数: %s\n\n' "$1" >&2; usage >&2; exit 1 ;;
esac

REPO_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILLS_SRC="$REPO_DIR/skills"
HERDR_SRC="$REPO_DIR/config/herdr-core"

# 通用 skill 目录（不绑定具体 agent 工具）
SKILLS_DST="${SKILLS_DIR:-$HOME/.agents/skills}"
# Claude Code 桥接目录（指向通用目录，便于 Claude Code 加载）
CLAUDE_DST="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
# herdr-core 配置目录
HERDR_DST="${HERDR_CONFIG_DIR:-${XDG_CONFIG_HOME:-$HOME/.config}/herdr-core}"

step() { printf '\n==> %s\n' "$*"; }
done_() { printf '    [ok]   %s\n' "$*"; }
skip_() { printf '    [skip] %s\n' "$*"; }
warn() { printf '    [warn] %s\n' "$*"; }

do_mkdir() { if [ "$DRY_RUN" -eq 0 ]; then mkdir -p "$1"; else printf '    mkdir -p %s\n' "$1"; fi; }
do_rm()    { if [ "$DRY_RUN" -eq 0 ]; then rm "$1"; else printf '    rm %s\n' "$1"; fi; }
do_ln()    { if [ "$DRY_RUN" -eq 0 ]; then ln -s "$1" "$2"; else printf '    ln -s %s %s\n' "$1" "$2"; fi; }
do_cp()    { if [ "$DRY_RUN" -eq 0 ]; then cp -R "$1" "$2"; else printf '    cp -R %s %s\n' "$1" "$2"; fi; }

# 把 $1 指向的目标统一为 $2（$1 为已存在的软链接）
repoint() {
  local dst="$1" target="$2"
  [ -L "$dst" ] || return 1
  if [ "$(readlink "$dst")" = "$target" ]; then
    return 0            # 已指向正确目标
  fi
  do_rm "$dst"
  do_ln "$target" "$dst"
  return 2              # 已重新链接
}

# 对每个 skill 执行 $1 目录中的链接/桥接
deploy_to_dir() {
  local dst_dir="$1" target_base="$2" label="$3"
  local src name dst target

  [ -d "$dst_dir" ] || do_mkdir "$dst_dir"

  for src in "$SKILLS_SRC"/*/; do
    [ -d "$src" ] || continue
    name="${src%/}"; name="${name##*/}"
    dst="$dst_dir/$name"
    target="$target_base/$name"

    if [ -L "$dst" ]; then
      # 注意：必须用 if 承接 repoint 的非零返回，避免触发 set -e
      if repoint "$dst" "$target"; then
        skip_ "$label: $name 已链接，跳过"
      else
        done_ "$label: 重新链接 $name -> $dst"
      fi
    elif [ -e "$dst" ]; then
      warn "$label: 跳过 $name：目标已存在且不是软链接（$dst），请手动处理"
    else
      do_ln "$target" "$dst"
      done_ "$label: 链接 $name -> $dst"
    fi
  done
}

# ---------------------------------------------------------------- skills
deploy_skills() {
  step "1/3 部署 skills 到通用 skill 目录（软链接）"
  printf '    源:   %s\n    目标: %s\n' "$SKILLS_SRC" "$SKILLS_DST"

  [ -d "$SKILLS_SRC" ] || { warn "未找到 skills 目录，跳过"; return; }

  local src name dst
  for src in "$SKILLS_SRC"/*/; do
    [ -d "$src" ] || continue
    name="${src%/}"; name="${name##*/}"
    [ -f "$src/SKILL.md" ] || warn "$name 缺少 SKILL.md，部分 agent 可能不会加载它"
  done

  deploy_to_dir "$SKILLS_DST" "$SKILLS_SRC" "通用"
}

# ---------------------------------------------------------------- claude 桥接
deploy_claude_bridge() {
  step "2/3 桥接通用 skill 到 Claude Code（软链接）"
  printf '    源:   %s\n    目标: %s\n' "$SKILLS_DST" "$CLAUDE_DST"

  [ "$NO_CLAUDE" -eq 1 ] && { skip_ "已用 --no-claude 跳过"; return; }
  [ -d "$SKILLS_SRC" ] || { warn "未找到 skills 目录，跳过"; return; }
  if [ "$CLAUDE_DST" = "$SKILLS_DST" ]; then
    skip_ "Claude 桥接目录与通用目录相同，无需桥接"
    return
  fi

  deploy_to_dir "$CLAUDE_DST" "$SKILLS_DST" "Claude"
}

# ---------------------------------------------------------------- herdr-core
deploy_herdr() {
  step "3/3 部署 herdr-core 配置（复制）"
  printf '    源:   %s\n    目标: %s\n' "$HERDR_SRC" "$HERDR_DST"

  [ -d "$HERDR_SRC" ] || { warn "未找到 config/herdr-core，跳过"; return; }
  [ -d "$HERDR_DST" ] || do_mkdir "$HERDR_DST"

  for src in "$HERDR_SRC"/*; do
    [ -e "$src" ] || continue
    name="${src##*/}"
    do_cp "$src" "$HERDR_DST/"
    done_ "复制 $name"
  done
}

# ---------------------------------------------------------------- main
printf '部署 opcflow-skills（仓库: %s）\n' "$REPO_DIR"
if [ "$DRY_RUN" -eq 1 ]; then
  printf '== 预览模式（--dry-run），不会修改任何文件 ==\n'
fi
deploy_skills
deploy_claude_bridge
deploy_herdr
printf '\n完成。平台: %s / %s\n' "$(uname -s)" "$(uname -m)"
