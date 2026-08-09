#!/usr/bin/env bash
# 画布补丁重放/验证脚本：把 brand/canvas-patches/*.patch 按 NN 序应用到 infinite-canvas/。
#
# 模式：
#   scripts/apply-canvas-patches.sh              # apply：当前干净工作区 strict 落地（发布/构建）
#   scripts/apply-canvas-patches.sh --preflight  # 只验 manifest / LF / patch 语法；零 worktree、零副作用
#   scripts/apply-canvas-patches.sh --check      # 临时 worktree从CANVAS_BASE_SHA strict重放；与CI一致
#   scripts/apply-canvas-patches.sh --check-3way # 临时 worktree三方重放；仅诊断上游漂移
#
# 关键不变式：任何 apply/check 前先完整 preflight，corrupt patch 必须在产生副作用前失败。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
SRC_DIR="$PROJECT_ROOT/infinite-canvas"
BRAND_DIR="$PROJECT_ROOT/brand"
PATCHES_DIR="$BRAND_DIR/canvas-patches"
BASE_SHA_FILE="$BRAND_DIR/CANVAS_BASE_SHA"
MANIFEST_FILE="$BRAND_DIR/canvas-patches.manifest"
PREFIX="canvas"

log()  { printf '\033[36m[%s]\033[0m %s\n' "$PREFIX" "$*"; }
warn() { printf '\033[33m[%s]\033[0m %s\n' "$PREFIX" "$*" >&2; }
err()  { printf '\033[31m[%s]\033[0m %s\n' "$PREFIX" "$*" >&2; }
die()  { err "$*"; exit 1; }
usage() { sed -n '2,10p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
read_base_sha() { tr -d '[:space:]' < "$BASE_SHA_FILE" 2>/dev/null || true; }

CHECK_WT=""
cleanup_wt() {
  [ -n "${CHECK_WT:-}" ] || return 0
  git -C "$SRC_DIR" worktree remove --force "$CHECK_WT" >/dev/null 2>&1 || true
  rm -rf "$CHECK_WT" >/dev/null 2>&1 || true
  CHECK_WT=""
}
trap cleanup_wt EXIT

list_patches() { find "$PATCHES_DIR" -maxdepth 1 -type f -name '*.patch' -print 2>/dev/null | LC_ALL=C sort; }
list_patch_basenames() {
  local p
  while IFS= read -r p; do [ -n "$p" ] && basename "$p"; done < <(list_patches)
}
list_manifest_patch_names() {
  grep -E '^\[[^][]+\]$' "$MANIFEST_FILE" 2>/dev/null | sed 's/^\[//; s/\]$//; s/$/.patch/' | LC_ALL=C sort
}

# 从 manifest 提取某 section 的文件列表（相对 SRC_DIR；与 apply-patches.sh 同款实现）。
manifest_files_for() {
  local name="$1"
  awk -v s="[$name]" '
    $0==s {f=1; next}
    /^\[/ {f=0}
    f && NF && $0 !~ /^#/ {print}
  ' "$MANIFEST_FILE"
}

run_manifest_check() {
  [ -f "$MANIFEST_FILE" ] || { err "缺少补丁清单：$MANIFEST_FILE"; return 1; }
  local actual expected missing extra
  actual="$(list_patch_basenames)"
  expected="$(list_manifest_patch_names)"
  missing="$(comm -23 <(printf '%s\n' "$actual") <(printf '%s\n' "$expected") || true)"
  extra="$(comm -13 <(printf '%s\n' "$actual") <(printf '%s\n' "$expected") || true)"
  if [ -n "$missing" ] || [ -n "$extra" ]; then
    err "manifest 与 patch 文件集不一致：$MANIFEST_FILE"
    if [ -n "$missing" ]; then
      err "manifest 缺少以下 section："
      printf '%s\n' "$missing" | sed 's/\.patch$//; s/^/        [/; s/$/]/' >&2
    fi
    if [ -n "$extra" ]; then
      err "manifest 声明了不存在的 patch："
      printf '%s\n' "$extra" | sed 's/^/        /' >&2
    fi
    return 1
  fi
  log "manifest 校验通过：$(printf '%s\n' "$actual" | sed '/^$/d' | wc -l) 个 patch section 一致。"
}

preflight_patch() {
  local patch="$1" name out
  name="$(basename "$patch")"
  if ! out="$(python3 "$SCRIPT_DIR/validate-patch.py" "$patch" 2>&1)"; then
    printf 'PARSE FAIL  %s\n' "$name" >&2
    printf '%s\n' "$out" | sed 's/^/        /' >&2
    return 1
  fi

  # Python 校验严格核对 hunk 结构，Git 校验覆盖 binary/扩展 header 等语义。
  if ! out="$(git -C "$SRC_DIR" apply --numstat "$patch" 2>&1)"; then
    printf 'PARSE FAIL  %s\n' "$name" >&2
    printf '%s\n' "$out" | sed 's/^/        /' >&2
    return 1
  fi

  # manifest 文件集一致性：该 section 声明的文件必须与补丁实际 diff 的文件**完全一致**
  # （防补丁与 manifest 漂移；与 apply-patches.sh 同款闸门）。
  local mf df
  mf="$(manifest_files_for "${name%.patch}" | LC_ALL=C sort)"
  df="$(printf '%s\n' "$out" | awk -F'\t' 'NF>=3{print $3}' | LC_ALL=C sort)"
  if [ "$mf" != "$df" ]; then
    printf 'FILES FAIL  %s（manifest 文件列表 ≠ 补丁实际 diff 文件集）\n' "$name" >&2
    diff <(printf '%s\n' "$mf") <(printf '%s\n' "$df") 2>/dev/null | sed 's/^</        仅 manifest: /; s/^>/        仅 补丁diff: /' | grep -v '^---$' >&2 || true
    return 1
  fi

  printf 'PARSE OK    %s\n' "$name"
  return 0
}

run_preflight() {
  run_manifest_check || return 1
  local total=0 fails=0 patch
  while IFS= read -r patch; do
    [ -n "$patch" ] || continue
    total=$((total + 1))
    preflight_patch "$patch" || fails=$((fails + 1))
  done < <(list_patches)
  if [ "$total" -eq 0 ]; then warn "$PATCHES_DIR 下没有 .patch，无补丁可预检。"; return 0; fi
  if [ "$fails" -ne 0 ]; then
    err "preflight 失败：$total 个补丁中 $fails 个未通过（解析 / manifest 文件集）；未创建 worktree、未修改 infinite-canvas/。"
    return 1
  fi
  log "preflight 通过：$total 个补丁均为 LF、可被 git apply 解析、且与 manifest 文件集一致。"
}

run_check_mode() {
  local mode="$1" base_sha patch name fails=0 total=0 label
  run_preflight || return 1
  base_sha="$(read_base_sha)"
  [ -n "$base_sha" ] || die "读取基线 SHA 失败：$BASE_SHA_FILE"
  git -C "$SRC_DIR" cat-file -e "${base_sha}^{commit}" 2>/dev/null \
    || die "infinite-canvas/ 内找不到基线 commit ${base_sha}（先 git submodule update --init）。"
  CHECK_WT="$(mktemp -d "${TMPDIR:-/tmp}/canvas-apply-check.XXXXXX")"
  git -C "$SRC_DIR" worktree add --detach "$CHECK_WT" "$base_sha" >/dev/null 2>&1 \
    || die "创建临时 worktree 失败（基线 ${base_sha}）。"
  if [ "$mode" = strict ]; then
    label="check(strict)"; log "${label}：从基线 $base_sha 按序 strict 重放（与 Release/CI 一致，不碰当前工作区）"
  else
    label="check(3way)"; warn "${label}：仅诊断上游漂移；成功不代表 Release/CI strict apply 可通过。"
  fi
  while IFS= read -r patch; do
    [ -n "$patch" ] || continue
    total=$((total + 1)); name="$(basename "$patch")"
    if [ "$mode" = strict ]; then
      if git -C "$CHECK_WT" apply "$patch" >/dev/null 2>&1; then
        printf 'APPLY OK    %s\n' "$name"
      else
        fails=$((fails + 1)); printf 'APPLY FAIL  %s\n' "$name" >&2
        git -C "$CHECK_WT" apply "$patch" 2>&1 | sed 's/^/        /' >&2 || true
      fi
    else
      if git -C "$CHECK_WT" apply --3way "$patch" >/dev/null 2>&1; then
        printf 'APPLY3 OK   %s\n' "$name"
      else
        fails=$((fails + 1)); printf 'APPLY3 FAIL %s\n' "$name" >&2
        git -C "$CHECK_WT" apply --3way "$patch" 2>&1 | sed 's/^/        /' >&2 || true
      fi
    fi
  done < <(list_patches)
  if [ "$fails" -ne 0 ]; then
    err "$label 失败：$total 个补丁中 $fails 个应用失败。"
    [ "$mode" = strict ] && warn "如需判断是否仅为上下文漂移，可运行：scripts/apply-canvas-patches.sh --check-3way"
    return 1
  fi
  log "$label 通过：$total 个补丁按序应用零冲突。"
}

run_apply() {
  run_preflight || return 1
  local base_sha head total=0 patch name
  base_sha="$(read_base_sha)"; head="$(git -C "$SRC_DIR" rev-parse HEAD 2>/dev/null || true)"
  if [ -n "$(git -C "$SRC_DIR" status --porcelain 2>/dev/null)" ]; then
    err "infinite-canvas/ 工作区非干净——可能已重放过补丁或有手改。"
    err "如需重新重放，先 git -C infinite-canvas checkout -f . && git -C infinite-canvas clean -fd。"
    return 1
  fi
  if [ -n "$base_sha" ] && [ -n "$head" ] && [ "$head" != "$base_sha" ]; then
    warn "infinite-canvas/ HEAD ($head) 与 CANVAS_BASE_SHA ($base_sha) 不一致，strict patch 可能不适用。"
  fi
  while IFS= read -r patch; do
    [ -n "$patch" ] || continue
    total=$((total + 1)); name="$(basename "$patch")"
    if git -C "$SRC_DIR" apply "$patch" >/dev/null 2>&1; then
      log "应用 $name"
    else
      err "应用 $name 失败："; git -C "$SRC_DIR" apply "$patch" 2>&1 | sed 's/^/        /' >&2 || true
      die "重放中断于 ${name}（前序补丁已落地，可 checkout -f 回退）。"
    fi
  done < <(list_patches)
  [ "$total" -gt 0 ] || { warn "$PATCHES_DIR 下没有 .patch，无补丁可应用。"; return 0; }
  log "已按序落地 $total 个补丁到 infinite-canvas/（gitlink 仍锁基线）。"
}

main() {
  local mode=apply
  case "${1:-}" in
    -h|--help) usage; exit 0;;
    --preflight) mode=preflight;;
    --check) mode=check;;
    --check-3way) mode=check-3way;;
    "") mode=apply;;
    *) die "未知参数：${1}（用 -h 查看用法）。";;
  esac
  [ -d "$SRC_DIR/.git" ] || [ -f "$SRC_DIR/.git" ] || die "找不到已初始化的 submodule：$SRC_DIR"
  [ -d "$PATCHES_DIR" ] || die "找不到补丁目录：$PATCHES_DIR"
  case "$mode" in
    preflight) run_preflight;;
    check) run_check_mode strict;;
    check-3way) run_check_mode 3way;;
    apply) run_apply;;
  esac
}
main "$@"
