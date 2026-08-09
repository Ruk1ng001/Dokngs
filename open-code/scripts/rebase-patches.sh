#!/usr/bin/env bash
# 补丁栈 rebase 脚本：把 brand/patches/*.patch 整体 rebase 到 opencode 上游新 tag。
#
# 背景：opencode submodule 锁在 brand/BASE_SHA；定制以 NN 序补丁叠加。上游发新版时，
# 补丁改到的「上游已有文件」可能漂移（上下文行偏移 / 逻辑冲突），strict apply 失败。
# 本脚本把「这次手工 rebase 到 v1.18.4」的流程固化成一条命令，只把真正需要人判断的
# 环节（解冲突 hunk）留给维护者，其余全自动。
#
# 两阶段用法（因解冲突必须人工，故拆两步）：
#   scripts/rebase-patches.sh plan v1.18.4     # ① 在 v1.18.4 worktree 逐补丁重放，
#                                              #    冲突处停下、落 .rej、报告。可反复重跑。
#   （维护者手工解 worktree 里的冲突文件 + 删对应 .rej）
#   scripts/rebase-patches.sh finish           # ② 重导出所有漂移补丁（保留注释头）、
#                                              #    刷新 BASE_TAG/BASE_SHA、跑 --check 验证。
#
#   scripts/rebase-patches.sh status           # 查看当前 rebase 进度（worktree / 待解冲突）
#   scripts/rebase-patches.sh abort            # 放弃：删 worktree 与状态，不改任何受控文件
#   scripts/rebase-patches.sh -h | --help
#
# 目标选择（默认 opencode，两条补丁栈可各自独立 rebase、状态互不干扰）：
#   scripts/rebase-patches.sh --target canvas plan v0.9.1   # 画布补丁栈 rebase 到画布上游新 tag
#   scripts/rebase-patches.sh --target canvas finish        # （其余子命令同理，--target 放子命令前）
#   canvas 目标使用 infinite-canvas/ submodule、brand/canvas-patches/、CANVAS_BASE_TAG/SHA、
#   apply-canvas-patches.sh 与独立状态目录 .rebase-state-canvas/。
#
# 设计不变式：
#   - 官方源码零手改承诺不变；本脚本只在临时 worktree 里操作，最终产物是 brand/patches/*、
#     brand/BASE_TAG、brand/BASE_SHA、父仓 opencode gitlink。
#   - 不自动提交、不自动推送——由维护者审阅 diff 后决定。
#   - 幂等/可恢复：plan 可反复重跑；中途放弃用 abort 清理，绝不留半污染状态。
#   - 复用现成脚本：apply-patches.sh（--preflight/--check）、export-patch.sh（导出+strict 验证）、
#     validate-patch.py（结构校验）。不重复实现这些逻辑。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
BRAND_DIR="$PROJECT_ROOT/brand"
EXPORT_SCRIPT="$SCRIPT_DIR/export-patch.sh"
VALIDATE_PY="$SCRIPT_DIR/validate-patch.py"

# —— 目标选择（--target opencode|canvas，默认 opencode；须放在子命令前）——
# 两个目标各用独立的 submodule / 补丁目录 / 基线文件 / apply 脚本 / worktree / 状态目录，
# 因此两条补丁栈可以各自独立进行 rebase，互不干扰。
TARGET="opencode"
if [ "${1:-}" = "--target" ]; then
  TARGET="${2:-}"
  shift 2 || { printf '\033[31m[rebase]\033[0m --target 缺少取值（opencode|canvas）。\n' >&2; exit 1; }
fi
case "$TARGET" in
  opencode)
    SRC_DIR="$PROJECT_ROOT/opencode"
    PATCHES_DIR="$BRAND_DIR/patches"
    MANIFEST_FILE="$BRAND_DIR/patches.manifest"
    BASE_TAG_FILE="$BRAND_DIR/BASE_TAG"
    BASE_SHA_FILE="$BRAND_DIR/BASE_SHA"
    APPLY_SCRIPT="$SCRIPT_DIR/apply-patches.sh"
    WORKTREE=".tmp-rebase"                       # 相对 SRC_DIR
    STATE_DIR="$PROJECT_ROOT/.rebase-state"      # 已列入 .gitignore（.rebase-state*/）
    UPSTREAM_URL_ENV="CX_UPSTREAM_URL"
    SUBMODULE_NAME="opencode"
    DEFAULT_UPSTREAM_URL="https://github.com/anomalyco/opencode.git"
    ;;
  canvas)
    SRC_DIR="$PROJECT_ROOT/infinite-canvas"
    PATCHES_DIR="$BRAND_DIR/canvas-patches"
    MANIFEST_FILE="$BRAND_DIR/canvas-patches.manifest"
    BASE_TAG_FILE="$BRAND_DIR/CANVAS_BASE_TAG"
    BASE_SHA_FILE="$BRAND_DIR/CANVAS_BASE_SHA"
    APPLY_SCRIPT="$SCRIPT_DIR/apply-canvas-patches.sh"
    WORKTREE=".tmp-rebase-canvas"                # 相对 SRC_DIR
    STATE_DIR="$PROJECT_ROOT/.rebase-state-canvas"
    UPSTREAM_URL_ENV="CANVAS_UPSTREAM_URL"
    SUBMODULE_NAME="infinite-canvas"
    DEFAULT_UPSTREAM_URL="https://github.com/basketikun/infinite-canvas.git"
    ;;
  *)
    printf '\033[31m[rebase]\033[0m 未知 --target：%s（仅支持 opencode|canvas）。\n' "$TARGET" >&2
    exit 1
    ;;
esac

WORKTREE_ABS="$SRC_DIR/$WORKTREE"
STATE_TARGET="$STATE_DIR/target-tag"          # 目标 tag
STATE_TARGET_SHA="$STATE_DIR/target-sha"      # 目标 tag 的 commit SHA
STATE_DRIFT="$STATE_DIR/drifted"              # 需重导出的补丁名（每行一个，无 .patch 后缀）
STATE_CKPT="$STATE_DIR/checkpoints"           # 「补丁名<TAB>pre-N 检查点 SHA」
STATE_CONFLICT="$STATE_DIR/conflict"          # 当前卡住待人工解的补丁名（空=无）

PREFIX="rebase:$TARGET"
log()  { printf '\033[36m[%s]\033[0m %s\n' "$PREFIX" "$*"; }
warn() { printf '\033[33m[%s]\033[0m %s\n' "$PREFIX" "$*" >&2; }
err()  { printf '\033[31m[%s]\033[0m %s\n' "$PREFIX" "$*" >&2; }
die()  { err "$*"; exit 1; }

usage() { sed -n '2,36p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }

# 提示文案里的自指命令（canvas 目标要带 --target，复制粘贴即可用）。
SELF_CMD="scripts/rebase-patches.sh"
[ "$TARGET" != "opencode" ] && SELF_CMD="scripts/rebase-patches.sh --target $TARGET"

read_base_tag() { tr -d '[:space:]' < "$BASE_TAG_FILE" 2>/dev/null || true; }
read_base_sha() { tr -d '[:space:]' < "$BASE_SHA_FILE" 2>/dev/null || true; }

# 上游 URL（同 update.sh 策略：优先 env，再 .gitmodules，最后公开 HTTPS）。
# env 变量名随 --target 变化（CX_UPSTREAM_URL / CANVAS_UPSTREAM_URL），用间接展开取值。
resolve_upstream_url() {
  local from_env="${!UPSTREAM_URL_ENV:-}"
  if [ -n "$from_env" ]; then printf '%s\n' "$from_env"; return 0; fi
  local u
  u="$(git -C "$PROJECT_ROOT" config -f .gitmodules "submodule.${SUBMODULE_NAME}.url" 2>/dev/null || true)"
  [ -n "$u" ] && { printf '%s\n' "$u"; return 0; }
  printf '%s\n' "$DEFAULT_UPSTREAM_URL"
}

# 补丁文件按 NN 序列出（全路径）。
list_patches() {
  find "$PATCHES_DIR" -maxdepth 1 -type f -name '*.patch' -print 2>/dev/null | LC_ALL=C sort
}

# 从补丁名（无后缀）拿全路径。
patch_path() { printf '%s/%s.patch\n' "$PATCHES_DIR" "$1"; }

# 补丁的注释头行数（第一个 diff --git 之前，全为 # 或空行）。无头返回 0。
patch_header_lines() {
  local p="$1"
  awk 'BEGIN{n=0} /^diff --git /{print n; exit} {n++} END{if(NR==0||n==NR)print n}' "$p"
}

# 抽出补丁注释头（不含 diff 正文）。无头则输出空。
extract_patch_header() {
  local p="$1" n
  n="$(patch_header_lines "$p")"
  [ "$n" -gt 0 ] && sed -n "1,${n}p" "$p"
}

# 从 manifest 提取某 section 的文件列表（相对 submodule 根）。
manifest_files_for() {
  local name="$1"
  awk -v s="[$name]" '
    $0==s {f=1; next}
    /^\[/ {f=0}
    f && NF && $0 !~ /^#/ {print}
  ' "$MANIFEST_FILE"
}

require_clean_submodule() {
  # 忽略脚本自己的 worktree 目录（.tmp-rebase/）——它是 rebase 中间产物，不是用户未导出的改动。
  # 排除它才能让 plan 在上次残留 worktree 存在时仍可清理并继续（否则死锁：清不掉又过不了检查）。
  if [ -n "$(git -C "$SRC_DIR" status --porcelain -- . ":(exclude)$WORKTREE" 2>/dev/null)" ]; then
    err "${SUBMODULE_NAME}/ 有未提交改动，拒绝 rebase（先导出到 ${PATCHES_DIR#"$PROJECT_ROOT/"}/ 或 checkout -f 回退）。"
    git -C "$SRC_DIR" status --short -- . ":(exclude)$WORKTREE" >&2
    exit 1
  fi
}

worktree_exists() {
  git -C "$SRC_DIR" worktree list --porcelain 2>/dev/null \
    | grep -qxF "worktree $WORKTREE_ABS"
}

remove_worktree() {
  worktree_exists && git -C "$SRC_DIR" worktree remove --force "$WORKTREE" >/dev/null 2>&1 || true
  rm -rf "$WORKTREE_ABS" >/dev/null 2>&1 || true
}

# ── plan：在目标 tag 的 worktree 逐补丁重放，冲突处停下 ────────────────────────
cmd_plan() {
  local target_tag="${1:-}"
  [ -n "$target_tag" ] || die "plan 需要目标 tag，例：${SELF_CMD} plan v1.18.4"

  [ -x "$APPLY_SCRIPT" ] || die "缺少 $APPLY_SCRIPT"
  [ -x "$EXPORT_SCRIPT" ] || die "缺少 $EXPORT_SCRIPT"
  [ -f "$MANIFEST_FILE" ] || die "缺少 manifest：$MANIFEST_FILE"

  # 先清掉上次残留的自有 worktree（否则它会被下面的洁净检查当成未提交改动而卡死）。
  remove_worktree
  require_clean_submodule

  # 先做零副作用预检：补丁语法坏就别开工。
  log "预检补丁语法与 manifest 一致性…"
  "$APPLY_SCRIPT" --preflight || die "preflight 失败，先修补丁再 rebase。"

  local url; url="$(resolve_upstream_url)"

  # 确保本地有目标 tag（本地无则从上游拉）。
  if ! git -C "$SRC_DIR" rev-parse -q --verify "refs/tags/${target_tag}" >/dev/null 2>&1; then
    log "本地无 tag ${target_tag}，从上游拉取：$url"
    git -C "$SRC_DIR" fetch --force "$url" \
      "refs/tags/${target_tag}:refs/tags/${target_tag}" >/dev/null 2>&1 \
      || die "拉取 tag ${target_tag} 失败：$url"
  fi
  local target_sha
  target_sha="$(git -C "$SRC_DIR" rev-parse "refs/tags/${target_tag}^{commit}" 2>/dev/null || true)"
  [ -n "$target_sha" ] || die "解析 tag ${target_tag} 的 commit SHA 失败。"

  # 干净起步：清旧 worktree 与状态。
  remove_worktree
  rm -rf "$STATE_DIR"
  mkdir -p "$STATE_DIR"
  printf '%s\n' "$target_tag" > "$STATE_TARGET"
  printf '%s\n' "$target_sha" > "$STATE_TARGET_SHA"
  : > "$STATE_DRIFT"
  : > "$STATE_CKPT"

  log "在 ${target_tag}（${target_sha}）建临时 worktree：$WORKTREE"
  git -C "$SRC_DIR" worktree add --detach "$WORKTREE" "$target_sha" >/dev/null 2>&1 \
    || die "创建 worktree 失败。"

  local wt="$WORKTREE_ABS"
  # worktree 内提交需要身份；用临时局部身份，绝不碰全局配置。
  git -C "$wt" config user.email "rebase@local" >/dev/null 2>&1 || true
  git -C "$wt" config user.name "rebase-bot" >/dev/null 2>&1 || true

  # 从第 1 个补丁开始重放。冲突则停在该补丁、留 .rej，等 continue。
  replay_from 1
}

# 从第 idx 个补丁（1-based，按 NN 序）开始逐补丁重放到 worktree。
# 每个补丁：strict → 3way → --reject 三级降级；strict/3way 成功即提交检查点并继续；
# --reject 落 .rej 后记录断点（STATE_CONFLICT）并 return，等维护者解冲突后 continue。
# 全部落地无残留 .rej 时打印 finish 引导。
replay_from() {
  local start_idx="$1" wt="$WORKTREE_ABS"
  local -a patches=()
  local p
  while IFS= read -r p; do [ -n "$p" ] && patches+=("$p"); done < <(list_patches)

  local total="${#patches[@]}" i name patch
  for (( i = start_idx; i <= total; i++ )); do
    patch="${patches[$((i-1))]}"
    name="$(basename "$patch" .patch)"

    # 记录 pre-N 检查点（当前 worktree HEAD）——供 finish 阶段按区间导出。
    local ckpt
    ckpt="$(git -C "$wt" rev-parse HEAD)"
    printf '%s\t%s\n' "$name" "$ckpt" >> "$STATE_CKPT"

    # ① strict：干净适用则直接落地，不算漂移。
    if git -C "$wt" apply "$patch" >/dev/null 2>&1; then
      git -C "$wt" add -A >/dev/null 2>&1
      git -C "$wt" commit -q -m "cp: $name (strict)" --allow-empty
      printf 'STRICT  %s\n' "$name"
      continue
    fi

    # ② 3way：能自动合并 → 落地并标记为「漂移，需重导出」。
    if git -C "$wt" apply --3way "$patch" >/dev/null 2>&1; then
      git -C "$wt" add -A >/dev/null 2>&1
      git -C "$wt" commit -q -m "cp: $name (3way)" --allow-empty
      printf '%s\n' "$name" >> "$STATE_DRIFT"
      printf '3WAY    %s  ← 上下文漂移，将重导出\n' "$name"
      continue
    fi

    # ③ 冲突：--reject 落干净 hunk + .rej，停下让人工解。
    # 注意：--reject 与 --3way 互斥（同用会报 "cannot be used together" 直接失败）。
    # 关键（实战修复）：② 的 `git apply --3way` 整体失败时**不是原子回滚**——能合并的文件
    # 会留在 index/工作区（staged），冲突文件留成 unmerged + <<<< 标记。若不先恢复，
    # 下面的 --reject 会在脏工作区上跑：已合并文件的所有 hunk 被误判 already-applied
    # 而整体落 .rej（包括本可干净套上的 hunk）。故先 reset --hard 回 pre-N 检查点
    # （此刻尚无 .rej，新增文件都已随前序 cp 提交入 HEAD，reset+clean 安全）。
    git -C "$wt" reset --hard -q >/dev/null 2>&1 || true
    git -C "$wt" clean -fdq >/dev/null 2>&1 || true
    # 此处走纯 --reject——把能干净套上的 hunk 落地、冲突 hunk 写成 .rej 供人工补；
    # 冲突文件保持上游原状 + .rej，不留半合并的 <<<< 标记。
    git -C "$wt" apply --reject "$patch" >/dev/null 2>&1 || true
    printf '%s\n' "$name" >> "$STATE_DRIFT"
    # 记录断点：continue 时从这个补丁的下一个继续（本补丁由 continue 提交）。
    printf '%s\t%s\n' "$name" "$i" > "$STATE_CONFLICT"
    printf 'CONFLICT %s  ← 需人工解冲突\n' "$name" >&2

    local rejects
    rejects="$(cd "$wt" && find . -name '*.rej' 2>/dev/null | sed 's#^\./##' | LC_ALL=C sort)"
    warn ""
    warn "补丁 ${name} 有冲突 hunk 无法自动合并（已重放 ${i}/${total}，其后补丁尚未重放）。"
    warn "请人工处理："
    warn "  1. 进入 worktree：cd $wt"
    warn "  2. 按下列 .rej 手工把改动补进对应源文件："
    printf '%s\n' "$rejects" | sed 's/^/         - /' >&2
    warn "  3. 改完后删除对应 .rej 文件。"
    warn "  4. 回项目根运行：${SELF_CMD} continue"
    warn "     （提交本补丁 + 从下一个补丁继续重放；再遇冲突会再次停下）"
    warn ""
    warn "放弃本次 rebase：${SELF_CMD} abort"
    return 0
  done

  # 全部补丁无残留冲突落地。
  rm -f "$STATE_CONFLICT"
  local nrej
  nrej="$(cd "$wt" && find . -name '*.rej' 2>/dev/null | wc -l | tr -d '[:space:]')"
  if [ "$nrej" != "0" ]; then
    warn "worktree 仍有 $nrej 个 .rej 未清理，解完再 continue。"
    return 0
  fi

  local target_tag; target_tag="$(cat "$STATE_TARGET" 2>/dev/null || echo '?')"
  log "全部补丁已在 ${target_tag} 落地，无残留冲突。"
  local ndrift
  ndrift="$(sed '/^$/d' "$STATE_DRIFT" | LC_ALL=C sort -u | wc -l | tr -d '[:space:]')"
  if [ "$ndrift" = "0" ]; then
    log "没有补丁漂移——理论上无需重导出，但仍建议 finish 以刷新 BASE 并跑 --check。"
  else
    log "有 $ndrift 个补丁漂移，将在 finish 阶段重导出："
    sed '/^$/d' "$STATE_DRIFT" | LC_ALL=C sort -u | sed 's/^/         - /'
  fi
  log "下一步：${SELF_CMD} finish"
}

# ── continue：提交已解冲突的补丁，从断点继续重放 ─────────────────────────────
cmd_continue() {
  [ -d "$STATE_DIR" ] || die "没有进行中的 rebase（先跑 plan）。"
  worktree_exists || die "找不到 rebase worktree（可能已被清理，abort 后重跑 plan）。"
  [ -f "$STATE_CONFLICT" ] || die "当前没有待解冲突的断点（若已全部落地，直接 finish）。"

  local wt="$WORKTREE_ABS" cname cidx
  cname="$(cut -f1 "$STATE_CONFLICT")"
  cidx="$(cut -f2 "$STATE_CONFLICT")"
  [ -n "$cname" ] && [ -n "$cidx" ] || die "断点状态损坏，abort 后重跑 plan。"

  # 冲突必须全解完（无 .rej）才能继续。
  local nrej
  nrej="$(cd "$wt" && find . -name '*.rej' 2>/dev/null | wc -l | tr -d '[:space:]')"
  [ "$nrej" = "0" ] || {
    err "worktree 仍有 $nrej 个 .rej 未解，解完再 continue："
    (cd "$wt" && find . -name '*.rej' 2>/dev/null | sed 's#^\./#         - #') >&2
    exit 1
  }

  # 提交手工解好的当前补丁（cname）为它的检查点。
  #
  # 关键（实战修复）：只数 .rej 是不够的——"把 .rej 删掉"和"把改动补进源文件"是两件事，
  # 而 --allow-empty 会让前者也顺利提交，于是一个**内容缺失**的检查点被当成解好的补丁。
  # 历史上真出过：编辑没生效但 rm -f *.rej 和 continue 照跑，08 补丁少了一整个 hunk 被
  # 提交成检查点，随后 finish 以它为 post-N 重导出，补丁直接缩水。
  # 故此处对「相对 pre-N 检查点的实际 delta」硬校验，绝不允许空提交。
  local cckpt
  cckpt="$(awk -F'\t' -v n="$cname" '$1==n{print $2; exit}' "$STATE_CKPT")"
  [ -n "$cckpt" ] || die "找不到 ${cname} 的 pre-N 检查点 SHA（状态损坏，abort 后重跑 plan）。"

  git -C "$wt" add -A >/dev/null 2>&1

  # ① 相对 pre-N 必须有实际改动（空 delta = 什么都没做）。
  if git -C "$wt" diff --quiet --cached "$cckpt" 2>/dev/null; then
    err "拒绝提交 ${cname}：相对 pre-N 检查点（${cckpt}）没有任何改动。"
    err ".rej 已删除但改动没落到源文件里——这会把一个内容缺失的补丁提交成检查点，"
    err "finish 阶段会据此重导出，补丁将静默缩水。"
    err "请回 worktree 确认改动已写入：cd $wt && git status"
    exit 1
  fi

  # ② 改动必须落在 manifest 声明的文件上（至少一个），否则说明改错了位置。
  local -a mfiles=()
  local mline
  while IFS= read -r mline; do
    [ -n "$mline" ] && mfiles+=("$mline")
  done < <(manifest_files_for "$cname")

  if [ "${#mfiles[@]}" -gt 0 ]; then
    local touched
    touched="$(git -C "$wt" diff --cached --name-only "$cckpt" -- "${mfiles[@]}" 2>/dev/null | sed '/^$/d')"
    if [ -z "$touched" ]; then
      err "拒绝提交 ${cname}：改动没有落在 manifest 声明的任何文件上。"
      err "manifest [${cname}] 声明的文件："
      printf '%s\n' "${mfiles[@]}" | sed 's/^/         - /' >&2
      err "实际改动的文件："
      git -C "$wt" diff --cached --name-only "$cckpt" 2>/dev/null | sed 's/^/         - /' >&2
      err "若上游把逻辑搬到了别的文件，请同步更新 ${MANIFEST_FILE#"$PROJECT_ROOT/"} 的 [${cname}] 段。"
      exit 1
    fi
  fi

  git -C "$wt" commit -q -m "cp: $cname (manual)"
  log "已提交手工解冲突的补丁：$cname"
  rm -f "$STATE_CONFLICT"

  # 从下一个补丁继续重放。
  replay_from "$((cidx + 1))"
}

# ── finish：重导出漂移补丁 + 刷新 BASE + --check ─────────────────────────────
cmd_finish() {
  [ -d "$STATE_DIR" ] || die "没有进行中的 rebase（先跑 plan）。"
  worktree_exists || die "找不到 rebase worktree（可能已被清理，重跑 plan）。"

  local target_tag target_sha wt="$WORKTREE_ABS"
  target_tag="$(cat "$STATE_TARGET" 2>/dev/null || true)"
  target_sha="$(cat "$STATE_TARGET_SHA" 2>/dev/null || true)"
  [ -n "$target_tag" ] && [ -n "$target_sha" ] || die "状态文件损坏，abort 后重跑 plan。"

  # 冲突必须全解完（无 .rej）。
  local nrej
  nrej="$(cd "$wt" && find . -name '*.rej' 2>/dev/null | wc -l | tr -d '[:space:]')"
  [ "$nrej" = "0" ] || die "worktree 仍有 $nrej 个 .rej 未解，解完再 finish。"

  # 把最终工作区（含手工解冲突结果）提交为终态检查点——供漂移补丁按区间导出。
  git -C "$wt" add -A >/dev/null 2>&1
  if [ -n "$(git -C "$wt" status --porcelain 2>/dev/null)" ]; then
    git -C "$wt" commit -q -m "final: all patches (with manual conflict resolution)" --allow-empty
  fi

  # 逐个漂移补丁重导出：以 pre-N 检查点为基线，diff 出该补丁覆盖的文件，拼回注释头。
  local drift_list
  drift_list="$(sed '/^$/d' "$STATE_DRIFT" | LC_ALL=C sort -u || true)"

  # 重导出结果先落 staging，**不直接覆盖受控补丁**——直到最终 --check 通过才安装。
  # 见下方「原子安装」段的说明。
  local staging
  staging="$(mktemp -d "${TMPDIR:-/tmp}/rebase-staging.XXXXXX")"

  if [ -z "$drift_list" ]; then
    log "无漂移补丁需重导出。"
  else
    local name ckpt final tmp header files_line
    while IFS= read -r name; do
      [ -n "$name" ] || continue
      final="$(patch_path "$name")"
      [ -f "$final" ] || die "补丁不存在：$final"

      ckpt="$(awk -F'\t' -v n="$name" '$1==n{print $2; exit}' "$STATE_CKPT")"
      [ -n "$ckpt" ] || die "找不到 ${name} 的 pre-N 检查点 SHA。"

      # post-N 检查点：pre-N 在通往 HEAD 线性历史上的直接子提交（= 应用补丁 N 后那次 commit）。
      # 重导出必须 diff「pre-N → post-N」，绝不能 diff「pre-N → HEAD(终态)」——后者会把 N 之后
      # 补丁对共享文件（如 07 与 17 共享 layout-new.tsx / cx-account-launcher.tsx）的改动一并
      # 算进 N，导致 strict 重放时 N 抢先写成终态、后续补丁 "does not apply"。历史严格线性
      # （每补丁一个 cp 提交），--ancestry-path 取 ckpt..HEAD 路径上最旧一个即 post-N。
      local post
      # sed -n 1p（非 head -1）：读完整个流不提前关闭管道，避免 rev-list 收 SIGPIPE 在
      # pipefail+set -e 下误触发 die。取 --ancestry-path 路径上最旧一个提交即 post-N。
      post="$(git -C "$wt" rev-list --reverse --ancestry-path "${ckpt}..HEAD" 2>/dev/null | sed -n 1p)"
      [ -n "$post" ] || die "找不到 ${name} 的 post-N 检查点（pre-N=${ckpt} 无子提交）。"

      # manifest 里该补丁覆盖的文件（相对 submodule 根）。
      local -a files=()
      while IFS= read -r files_line; do
        [ -n "$files_line" ] && files+=("$files_line")
      done < <(manifest_files_for "$name")
      [ "${#files[@]}" -gt 0 ] || die "manifest 中 [$name] 没有文件列表。"

      # 反推真实文件集并与 manifest 对账。
      #
      # 为什么必要：下面的导出用 `-- "${files[@]}"` 按 manifest 过滤路径。若手工解冲突时
      # 动到了 manifest 之外的文件（典型场景：上游把逻辑从 old.ts 搬到 new.ts，维护者正确
      # 跟进改了 new.ts），`git add -A` 会把它收进检查点，但导出时被路径过滤器**静默丢弃**——
      # 补丁看着导出成功、--check 也过（因为剩下的部分自洽），可那部分定制就这么没了。
      # 故此处以「pre-N → post-N 的真实 diff」为准绳，与 manifest 声明集双向对账。
      local actual_files
      actual_files="$(git -C "$wt" diff --name-only "$ckpt" "$post" 2>/dev/null | sed '/^$/d' | LC_ALL=C sort)"
      local declared_files
      declared_files="$(printf '%s\n' "${files[@]}" | sed '/^$/d' | LC_ALL=C sort -u)"

      # 真实改了但 manifest 没声明 → 导出会丢内容，硬失败。
      local undeclared
      undeclared="$(LC_ALL=C comm -23 <(printf '%s\n' "$actual_files") <(printf '%s\n' "$declared_files") || true)"
      if [ -n "$undeclared" ]; then
        err "重导出 ${name} 中止：以下文件被改动但 manifest 未声明，会被路径过滤器静默丢弃："
        printf '%s\n' "$undeclared" | sed 's/^/         + /' >&2
        err "若这些改动属于 ${name}（例如上游把逻辑搬了家），请把它们补进 ${MANIFEST_FILE#"$PROJECT_ROOT/"} 的 [${name}] 段后重跑 finish。"
        err "worktree 与检查点已保留：$wt"
        die "manifest 与实际改动不一致，拒绝导出不完整的补丁。"
      fi

      # manifest 声明了但这次没改 → 多为上游删文件/该 hunk 已被上游吸收，提示但不阻断
      # （真正的缺失会在最后的 --check 与语义断言里暴露）。
      local unchanged
      unchanged="$(LC_ALL=C comm -13 <(printf '%s\n' "$actual_files") <(printf '%s\n' "$declared_files") || true)"
      if [ -n "$unchanged" ]; then
        warn "${name}：manifest 声明但本次未改动的文件（上游可能已吸收该改动或删除了文件）："
        printf '%s\n' "$unchanged" | sed 's/^/         - /' >&2
        warn "  若确认不再需要，记得从 manifest 的 [${name}] 段移除，并确认对应定制未丢失。"
      fi

      # 新增文件需 intent-to-add 才进 git diff（不改 index 内容）。
      local f
      for f in "${files[@]}"; do
        if ! git -C "$wt" ls-files --error-unmatch -- "$f" >/dev/null 2>&1; then
          git -C "$wt" add -N -- "$f" >/dev/null 2>&1 || true
        fi
      done

      # 抽出旧补丁的注释头（重导出后拼回）。
      header="$(extract_patch_header "$final" || true)"

      tmp="$(mktemp "${TMPDIR:-/tmp}/rebase-export.XXXXXX")"
      {
        [ -n "$header" ] && printf '%s\n' "$header"
        git -C "$wt" diff --binary "$ckpt" "$post" -- "${files[@]}"
      } > "$tmp"

      # 结构校验：拼头后仍须是合法 unified diff（注释头是 git apply 容忍的前导文本）。
      if ! python3 "$VALIDATE_PY" "$tmp" >/dev/null 2>&1; then
        rm -f "$tmp"
        die "重导出的 ${name} 不是结构合法的 unified diff。"
      fi
      # git apply 解析校验（在目标 tag worktree 的 pre-N 检查点上）。
      if ! git -C "$wt" apply --numstat "$tmp" >/dev/null 2>&1; then
        rm -f "$tmp"
        die "重导出的 ${name} 无法被 git apply 解析。"
      fi

      # 落 staging（文件名与受控补丁同名），暂不覆盖 $final。
      mv -f "$tmp" "$staging/$(basename "$final")"
      log "已重导出：$name"
    done < <(printf '%s\n' "$drift_list")
  fi

  # ── 原子安装：验证通过才落地，失败则完整回滚并保留恢复现场 ────────────────────
  #
  # 为什么这么绕：旧实现的顺序是「覆盖补丁 → 刷新 BASE → 切 submodule → 删 worktree →
  # 删状态目录 → 最后才跑 --check」。一旦 --check 失败，检查点、手工解冲突结果、worktree
  # 全都已经没了，重跑还会报「没有进行中的 rebase」——维护者刚花一小时解的冲突直接蒸发，
  # 只能从头再来。
  #
  # 现在：先备份全部受控文件 → 安装 staging → 刷新 BASE → 切 submodule → 跑 --check。
  # 通过才删 worktree/状态；失败则把补丁、BASE、submodule 全部还原到 finish 之前的样子，
  # 并**保留** worktree 与 .rebase-state，维护者改完 worktree 再跑一次 finish 即可。
  # 洁净检查放在备份之前：此刻尚未碰任何受控文件，直接退出是安全的。
  require_clean_submodule

  local backup="$STATE_DIR/backup"
  rm -rf "$backup"
  mkdir -p "$backup"

  # 备份：受控补丁目录、两个基线文件、submodule 原 HEAD。
  cp -a "$PATCHES_DIR" "$backup/patches" 2>/dev/null || true
  [ -f "$BASE_TAG_FILE" ] && cp -a "$BASE_TAG_FILE" "$backup/BASE_TAG"
  [ -f "$BASE_SHA_FILE" ] && cp -a "$BASE_SHA_FILE" "$backup/BASE_SHA"
  local prev_head
  prev_head="$(git -C "$SRC_DIR" rev-parse HEAD 2>/dev/null || true)"
  printf '%s\n' "$prev_head" > "$backup/submodule-head"

  # 回滚到 finish 之前的状态（保留 worktree 与状态目录，供再次 finish）。
  rollback_finish() {
    warn "正在回滚 finish 的改动…"
    if [ -d "$backup/patches" ]; then
      rm -rf "$PATCHES_DIR"
      cp -a "$backup/patches" "$PATCHES_DIR"
    fi
    [ -f "$backup/BASE_TAG" ] && cp -a "$backup/BASE_TAG" "$BASE_TAG_FILE"
    [ -f "$backup/BASE_SHA" ] && cp -a "$backup/BASE_SHA" "$BASE_SHA_FILE"
    if [ -n "$prev_head" ] && git -C "$SRC_DIR" cat-file -e "${prev_head}^{commit}" 2>/dev/null; then
      git -C "$SRC_DIR" checkout -f "$prev_head" >/dev/null 2>&1 || true
      # -e 排除自有 worktree：clean 不能把维护者的解冲突现场一起删掉。
      git -C "$SRC_DIR" clean -fdq -e "$WORKTREE" >/dev/null 2>&1 || true
      git -C "$PROJECT_ROOT" add "$SUBMODULE_NAME" >/dev/null 2>&1 || true
    fi
    warn "已回滚：补丁、BASE_TAG/SHA、submodule gitlink 均恢复为 finish 之前的状态。"
    warn "worktree 与检查点已保留，可继续修改后重跑：${SELF_CMD} finish"
    warn "  worktree：$wt"
    warn "彻底放弃：${SELF_CMD} abort"
  }

  # 安装 staging 里的重导出补丁。
  local sf
  for sf in "$staging"/*.patch; do
    [ -e "$sf" ] || continue
    mv -f "$sf" "$PATCHES_DIR/$(basename "$sf")"
  done
  rm -rf "$staging"

  # 刷新基线锁定文件（末尾保留换行，同 update.sh 约定）。
  printf '%s\n' "$target_tag" > "$BASE_TAG_FILE"
  printf '%s\n' "$target_sha" > "$BASE_SHA_FILE"
  log "已刷新基线：BASE_TAG=$target_tag  BASE_SHA=$target_sha"

  # 把父仓 submodule 切到目标 tag 并暂存 gitlink（供本地一致、CI 干净跟随）。
  if ! git -C "$SRC_DIR" checkout -f "refs/tags/${target_tag}" >/dev/null 2>&1; then
    rollback_finish
    die "把主 submodule 切到 ${target_tag} 失败。"
  fi
  git -C "$SRC_DIR" clean -fdq -e "$WORKTREE" >/dev/null 2>&1 || true
  git -C "$PROJECT_ROOT" add "$SUBMODULE_NAME" >/dev/null 2>&1 || true

  # 最终 CI 等价验证：从新 BASE_SHA strict 重放全部补丁（含 manifest 一致性与语义断言）。
  log "跑 CI 等价 strict 重放验证（--check）…"
  if ! "$APPLY_SCRIPT" --check; then
    err "--check 失败！补丁栈在新基线上仍有问题。"
    rollback_finish
    return 1
  fi

  # 通过后才销毁恢复现场。
  remove_worktree
  rm -rf "$STATE_DIR"
  log "rebase 完成：补丁栈已 rebase 到 ${target_tag}，strict 重放零冲突。"
  log "请审阅改动后提交：git add brand/ ${SUBMODULE_NAME} && git commit"
}

cmd_status() {
  if [ ! -d "$STATE_DIR" ]; then
    log "当前没有进行中的 rebase。"
    return 0
  fi
  local target_tag; target_tag="$(cat "$STATE_TARGET" 2>/dev/null || echo '?')"
  log "进行中的 rebase 目标：$target_tag"
  if worktree_exists; then
    log "worktree：$WORKTREE_ABS"
    local nrej
    nrej="$(cd "$WORKTREE_ABS" && find . -name '*.rej' 2>/dev/null | wc -l | tr -d '[:space:]')"
    if [ "$nrej" != "0" ]; then
      warn "待解冲突 .rej（$nrej 个）："
      (cd "$WORKTREE_ABS" && find . -name '*.rej' 2>/dev/null | sed 's#^\./#         - #') >&2
    else
      log "无残留 .rej，可运行 finish。"
    fi
  else
    warn "worktree 已不存在，建议 abort 后重跑 plan。"
  fi
  if [ -s "$STATE_DRIFT" ]; then
    log "漂移补丁（将重导出）："
    sed '/^$/d' "$STATE_DRIFT" | LC_ALL=C sort -u | sed 's/^/         - /'
  fi
  if [ -d "$STATE_DIR/backup" ]; then
    warn "存在上次 finish 失败留下的备份（补丁/BASE 已回滚到 finish 之前）："
    warn "  $STATE_DIR/backup"
    warn "  改完 worktree 可直接重跑 finish；彻底放弃用 abort。"
  fi
}

cmd_abort() {
  remove_worktree
  rm -rf "$STATE_DIR"
  log "已放弃 rebase：worktree 与状态已清理，brand/ 与 gitlink 未改动。"
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    -h|--help|"") usage; [ -z "$cmd" ] && exit 1; exit 0 ;;
  esac
  shift || true

  [ -d "$SRC_DIR/.git" ] || [ -f "$SRC_DIR/.git" ] \
    || die "找不到已初始化的 submodule：$SRC_DIR（先 git submodule update --init）。"

  case "$cmd" in
    plan)     cmd_plan "$@" ;;
    continue) cmd_continue ;;
    finish)   cmd_finish ;;
    status) cmd_status ;;
    abort)  cmd_abort ;;
    *) die "未知子命令：$cmd（用 -h 查看用法）。" ;;
  esac
}

main "$@"
