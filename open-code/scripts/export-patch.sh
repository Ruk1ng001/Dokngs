#!/usr/bin/env bash
# 安全导出补丁：只从源码 diff 生成 unified diff，原子替换，随后跑完整 strict 累积重放；失败自动恢复。
#
# 用法：
#   scripts/export-patch.sh opencode 17-canvas-embed --base-worktree .tmp-patch -- <文件...>
#   scripts/export-patch.sh canvas 02-embed-ui --base-worktree .tmp-canvas-patch -- <文件...>
#
# --base-worktree 必须是已准备好的 pre-N 检查点 worktree，且文件已从最终工作区复制进去。
# 导出以该 worktree 的 HEAD 为基线，避免共享文件把前序补丁改动混进当前 patch。
# 禁止直接手改 .patch 正文；应修改 worktree 源码后重新运行本脚本。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

log() { printf '\033[36m[patch-export]\033[0m %s\n' "$*"; }
err() { printf '\033[31m[patch-export]\033[0m %s\n' "$*" >&2; }
die() { err "$*"; exit 1; }

usage() {
  sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

[ "$#" -ge 1 ] || { usage; exit 1; }
case "$1" in
  -h|--help) usage; exit 0;;
esac
[ "$#" -ge 2 ] || die "缺少 target / patch 名。"

target="$1"
name="$2"
shift 2
[[ "$name" =~ ^[0-9][0-9]-[A-Za-z0-9._-]+$ ]] || die "非法补丁名：${name}（须为 NN-name）。"

case "$target" in
  opencode)
    source_repo="$PROJECT_ROOT/opencode"
    patch_dir="$PROJECT_ROOT/brand/patches"
    manifest="$PROJECT_ROOT/brand/patches.manifest"
    check_script="$PROJECT_ROOT/scripts/apply-patches.sh"
    ;;
  canvas)
    source_repo="$PROJECT_ROOT/infinite-canvas"
    patch_dir="$PROJECT_ROOT/brand/canvas-patches"
    manifest="$PROJECT_ROOT/brand/canvas-patches.manifest"
    check_script="$PROJECT_ROOT/scripts/apply-canvas-patches.sh"
    ;;
  *) die "未知 target：${target}（仅支持 opencode|canvas）。";;
esac

base_worktree=""
if [ "${1:-}" = "--base-worktree" ]; then
  [ "$#" -ge 2 ] || die "--base-worktree 缺少路径。"
  base_worktree="$2"
  shift 2
fi
[ "${1:-}" = "--" ] || die "文件列表前必须有 --。"
shift
[ "$#" -gt 0 ] || die "必须明确列出要导出的文件，禁止默认导出整个脏工作区。"

if [[ "$base_worktree" != /* ]]; then
  base_worktree="$PROJECT_ROOT/$base_worktree"
fi
[ -d "$base_worktree" ] || die "找不到 pre-N worktree：$base_worktree"
git -C "$base_worktree" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "不是 git worktree：$base_worktree"

# worktree 必须属于对应 submodule，防止把错误仓库的 diff 导出到 patch 目录。
source_common="$(git -C "$source_repo" rev-parse --git-common-dir)"
worktree_common="$(git -C "$base_worktree" rev-parse --git-common-dir)"
source_common="$(cd "$source_repo" && cd "$source_common" && pwd)"
worktree_common="$(cd "$base_worktree" && cd "$worktree_common" && pwd)"
[ "$source_common" = "$worktree_common" ] || die "--base-worktree 不属于 $target submodule。"

section="[$name]"
grep -Fxq "$section" "$manifest" || die "manifest 缺少 ${section}：$manifest"

# 防止绝对路径、上跳路径和不存在于 worktree 的路径。
files=()
for file in "$@"; do
  case "$file" in
    /*|../*|*/../*|..|*\\*) die "非法相对路径：$file";;
  esac
  [ -e "$base_worktree/$file" ] || [ -L "$base_worktree/$file" ] \
    || die "worktree 中不存在：${file}（删除文件请先用 git rm 并由维护者单独导出）。"
  files+=("$file")
done

mkdir -p "$patch_dir"
final="$patch_dir/$name.patch"
tmp="$(mktemp "${TMPDIR:-/tmp}/export-patch.XXXXXX")"
backup=""
installed=0
cleanup() {
  rm -f "$tmp"
  if [ "$installed" -eq 1 ] && [ -n "$backup" ] && [ -f "$backup" ]; then
    mv -f "$backup" "$final"
    err "验证失败，已恢复旧补丁：$final"
  elif [ "$installed" -eq 1 ] && [ -z "$backup" ]; then
    rm -f "$final"
    err "验证失败，已移除新补丁：$final"
  fi
}
trap cleanup EXIT

# 新文件必须 intent-to-add 才会进入普通 git diff；不改 index 内容，仅设置意图位。
for file in "${files[@]}"; do
  if ! git -C "$base_worktree" ls-files --error-unmatch -- "$file" >/dev/null 2>&1; then
    git -C "$base_worktree" add -N -- "$file"
  fi
done

git -C "$base_worktree" diff --binary -- "${files[@]}" > "$tmp"
[ -s "$tmp" ] || die "这些文件相对检查点没有 diff，未导出。"
if ! python3 "$SCRIPT_DIR/validate-patch.py" "$tmp"; then
  die "生成结果不是结构合法的 unified diff。"
fi
git -C "$base_worktree" apply --numstat "$tmp" >/dev/null \
  || die "生成结果不能被 git apply 解析。"

if [ -f "$final" ]; then
  backup="$(mktemp "${TMPDIR:-/tmp}/old-patch.XXXXXX")"
  cp "$final" "$backup"
fi
mv -f "$tmp" "$final"
installed=1

log "已原子替换：$final"
if ! "$check_script" --check; then
  die "strict 累积验证失败。"
fi

installed=0
[ -n "$backup" ] && rm -f "$backup"
log "导出成功并通过 strict 重放。请人工确认 $manifest 中 $section 的说明仍准确。"
