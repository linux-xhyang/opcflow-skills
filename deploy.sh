#!/usr/bin/env bash
# deploy.sh — 兼容总入口：依次部署 skills 与 Herdr 配置。

set -euo pipefail

usage() {
  cat <<EOF
用法: $0 [选项]

  无选项            依次运行 skill deploy 与 Herdr deploy
  -n, --dry-run     只预览，不修改文件
  --no-claude       skill deploy 不桥接到 Claude Code
  --no-switch       Herdr deploy 后不切换到 emacs-main layout
  -h, --help        显示本帮助

也可以独立执行：
  ./deploy-skills.sh [--dry-run] [--no-claude]
  ./deploy-herdr.sh  [--dry-run] [--no-switch]
EOF
}

DRY_RUN=0
NO_CLAUDE=0
NO_SWITCH=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    -n|--dry-run) DRY_RUN=1 ;;
    --no-claude)  NO_CLAUDE=1 ;;
    --no-switch)  NO_SWITCH=1 ;;
    -h|--help)    usage; exit 0 ;;
    *)            printf '未知参数: %s\n\n' "$1" >&2; usage >&2; exit 1 ;;
  esac
  shift
done

REPO_DIR="$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_ARGS=()
HERDR_ARGS=()
[ "$DRY_RUN" -eq 0 ] || { SKILL_ARGS+=(--dry-run); HERDR_ARGS+=(--dry-run); }
[ "$NO_CLAUDE" -eq 0 ] || SKILL_ARGS+=(--no-claude)
[ "$NO_SWITCH" -eq 0 ] || HERDR_ARGS+=(--no-switch)

"$REPO_DIR/deploy-skills.sh" "${SKILL_ARGS[@]}"
"$REPO_DIR/deploy-herdr.sh" "${HERDR_ARGS[@]}"
