#!/usr/bin/env bash
# deploy-third-party.sh — 安装第三方开源 skills
# 兼容 macOS 自带 bash 3.2 与 Linux bash；需要 node/npx
#
# 通过 skills.sh 官方 CLI 全局安装到通用 skill 目录（默认 ~/.agents/skills），
# 安装后桥接一份到 ~/.claude/skills 供 Claude Code 加载。

set -euo pipefail

usage() {
  cat <<EOF
用法: $0 [选项]

  无选项            安装下列仓库的 skills 到通用 skill 目录
                    （全局: ~/.agents/skills），并桥接到 Claude Code
  -n, --dry-run     只打印将要执行的命令，不安装
  --no-claude       安装后不桥接到 ~/.claude/skills
  -h, --help        显示本帮助

技能来源:
  - https://github.com/mattpocock/skills
  - https://github.com/tt-a1i/archify
安装工具: npx skills@latest add（skills.sh 官方 CLI，需要联网）
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

# ------------------------------------------------------------------ 清单
# mattpocock/skills（安装时自动去重）。
# 分组来源（Matt Pocock 的使用场景划分）:
#   Main flow:    grill-with-docs grilling domain-modeling / to-spec / to-tickets
#                 / implement tdd code-review / code-review / retro writing-for-agents
#   Shaping:      wayfinder research prototype grilling domain-modeling
#   Engineering:  improve-codebase-architecture codebase-design grilling domain-modeling
#                 / diagnosing-bugs / triage grilling domain-modeling
#                 / wizard / implement-spec tdd code-review
#   Productivity: grill-me grilling / handoff / to-questionnaire / writing-for-agents
MATTPOCOCK_SKILLS="
grill-with-docs grilling domain-modeling
to-spec
to-tickets
implement tdd code-review
retro writing-for-agents
wayfinder research prototype
improve-codebase-architecture codebase-design
diagnosing-bugs
triage
wizard
implement-spec
grill-me
handoff
to-questionnaire
"

# tt-a1i/archify
ARCHIFY_SKILLS="
archify
"

# 全部已收集技能（跨仓库去重）
ALL_SKILLS=""
# 本次调用新增的技能（collect_skills 的输出，须在父 shell 中调用）
NEW_SKILLS=""

# 去重收集：把 $1 中的技能名追加到 ALL_SKILLS，新增部分写入 NEW_SKILLS。
# 注意：必须直接调用（不能用命令替换），否则 ALL_SKILLS 的修改会丢失在子 shell 里。
collect_skills() {
  local seen="" s
  for s in $1; do
    case " $seen " in
      *" $s "*) continue ;;
    esac
    case " $ALL_SKILLS " in
      *" $s "*) continue ;;
    esac
    seen="$seen $s"
    ALL_SKILLS="$ALL_SKILLS $s"
  done
  seen="${seen# }"
  NEW_SKILLS="$seen"
}

# ------------------------------------------------------------------ 安装
install_package() {
  local repo="$1" list="$2" args=() s
  collect_skills "$list"
  [ -z "$NEW_SKILLS" ] && return
  args=()
  for s in $NEW_SKILLS; do
    args+=(--skill="$s")
  done

  printf '\n==> %s\n    技能: %s\n' "$repo" "$NEW_SKILLS"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf '    npx --yes skills@latest add %s -g -y %s\n' "$repo" "${args[*]}"
    return
  fi
  npx --yes skills@latest add "$repo" -g -y "${args[@]}"
}

# ---------------------------------------------------------------- Claude 桥接
bridge_to_claude() {
  local src_dir="${SKILLS_DIR:-$HOME/.agents/skills}"
  local dst_dir="${CLAUDE_SKILLS_DIR:-$HOME/.claude/skills}"
  local s dst target

  [ "$NO_CLAUDE" -eq 1 ] && { printf '[skip] 已用 --no-claude 跳过 Claude 桥接\n'; return; }
  [ -d "$src_dir" ] || { printf '[warn] 未找到通用 skill 目录: %s，跳过桥接\n' "$src_dir"; return; }

  printf '\n==> 桥接新装的 skill 到 Claude Code（%s）\n' "$dst_dir"
  mkdir -p "$dst_dir"

  for s in $ALL_SKILLS; do
    [ -e "$src_dir/$s" ] || { printf '    [warn] 通用目录中未找到 %s，跳过\n' "$s"; continue; }
    dst="$dst_dir/$s"
    target="$src_dir/$s"
    if [ -L "$dst" ]; then
      if [ "$(readlink "$dst")" = "$target" ]; then
        printf '    [skip] %s 已桥接，跳过\n' "$s"
        continue
      fi
      rm "$dst"
    elif [ -e "$dst" ]; then
      printf '    [warn] 跳过 %s：目标已存在且不是软链接（%s），请手动处理\n' "$s" "$dst"
      continue
    fi
    ln -s "$target" "$dst"
    printf '    [ok]   %s -> %s\n' "$s" "$dst"
  done
}

# ---------------------------------------------------------------- main
if [ "$DRY_RUN" -eq 1 ]; then
  printf '== 预览模式（--dry-run），不会修改任何文件 ==\n'
fi

command -v node >/dev/null 2>&1 || { printf '错误: 未找到 node，无法运行 npx。请先安装 Node.js。\n' >&2; exit 1; }
command -v npx >/dev/null 2>&1 || { printf '错误: 未找到 npx。\n' >&2; exit 1; }

install_package "mattpocock/skills" "$MATTPOCOCK_SKILLS"
install_package "tt-a1i/archify" "$ARCHIFY_SKILLS"

if [ "$DRY_RUN" -eq 1 ]; then
  printf '\n（预览结束，未执行任何操作）\n'
  exit 0
fi

bridge_to_claude
printf '\n完成。可用 npx skills@latest list 查看已安装技能。\n'
