#!/usr/bin/env bash
# 官方客户端镜像同步：检测 Claude Desktop / ChatGPT Desktop / Claude Code /
# Codex CLI / Gemini CLI 官方最新版，下载后按固定文件名上传 R2 的 official/
# 目录（同名覆盖）。
#
# 文件名契约与 new-api 后端 controller/official_downloads.go 的 catalog 一一对应
# （规范文档：R2 official/ 上传路径清单）。VERSION 最后上传——首页按钮以文件存在
# 为准，先传二进制再写 VERSION，避免版本号先于文件生效。
#
# 完整性保证与其边界：
#   - publish 要求调用方声明本次期望产物集，缺任何一个就整次放弃、不推进 VERSION。
#     这消除了「某平台失败 → 其余照传 → VERSION 推进 → 此后永远跳过」的永久混版。
#   - 仍未消除的是**上传过程本身的非原子性**：固定文件名同名覆盖，若在上传第 3 个文件时
#     失败，线上会短暂处于「部分新包 + 部分旧包」，直到下一次运行覆盖修正。窗口通常是
#     分钟级（每日 CI 会重试），且 VERSION 尚未推进故首页版本号仍是旧值。
#     彻底修法是改成「版本化不可变目录 + 一次指针切换」（official/<client>/<version>/...
#     加一个 manifest/软链），但那会改动 R2 目录结构与 new-api 后端 catalog 的读取路径，
#     属于跨仓协调改动，需与后端一并规划，不在本脚本内单方面变更。
#
# 用法：
#   mirror-official-clients.sh [all|claude-desktop|chatgpt|claude-code|codex|gemini-cli ...]
# 环境变量：
#   R2_ACCOUNT_ID / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY / R2_BUCKET  上传所需
#   （aws CLI 走 AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY，由 CI 映射）
#   DL_BASE      线上只读基址，用于读取当前 VERSION（默认 https://dl.dokng.com）
#   FORCE=1      版本相同也重新镜像
#   DRY_RUN=1    完整下载/校验/打包但不上传
#   CHECK_ONLY=1 只做版本探测与资产 URL 可达性检查（HEAD），不下载不上传
set -euo pipefail

DL_BASE="${DL_BASE:-https://dl.dokng.com}"
FORCE="${FORCE:-}"
DRY_RUN="${DRY_RUN:-}"
CHECK_ONLY="${CHECK_ONLY:-}"

OSPREY="https://storage.googleapis.com/osprey-downloads-c02f6a0d-347c-492b-a752-3e0651722e97"
CC_GCS="https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases"
GH_API="https://api.github.com"

# ChatGPT Desktop（Store 里发布者 OpenAI、包名 OpenAI.Codex，即原 Codex desktop）
CHATGPT_DMG="https://persistent.oaistatic.com/sidekick/public/ChatGPT.dmg"
CHATGPT_STORE_PRODUCT_ID="9PLM9XGG6VKS"

ALL_CLIENTS=(claude-desktop chatgpt claude-code codex gemini-cli)

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\033[36m[mirror]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[mirror][warn]\033[0m %s\n' "$*" >&2; }

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

SUMMARY=()
# 降级客户端：本次没失败（线上仍是完整的上一版），但也没同步到上游最新。
# 与 OK 区分开，避免「上游永久停发某分发形态」被长期当成正常。
DEGRADED=()
add_summary() {
  SUMMARY+=("$1")
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    printf '%s\n' "- $1" >> "$GITHUB_STEP_SUMMARY"
  fi
}

# ---------- 通用工具 ----------

fetch() { # fetch <url>  → stdout（小文本，带重试）
  curl -fsSL --retry 3 --retry-delay 2 --max-time 60 "$1"
}

gh_api() { # gh_api <path> → stdout（带可选 token，规避匿名限流）
  local auth=()
  [ -n "${GH_TOKEN:-}" ] && auth=(-H "Authorization: Bearer ${GH_TOKEN}")
  curl -fsSL --retry 3 --retry-delay 2 --max-time 60 "${auth[@]}" \
    -H "Accept: application/vnd.github+json" "${GH_API}$1"
}

download() { # download <url> <dest>（大文件，带重试与断点续传）
  log "下载 $(basename "$2") ← $1"
  curl -fL --retry 3 --retry-delay 3 -C - -o "$2" "$1"
}

head_ok() { # head_ok <url> → HEAD 请求 2xx 即成功
  curl -fsIL --retry 2 --max-time 30 -o /dev/null "$1"
}

remote_version() { # remote_version <client> → 当前线上 VERSION（无/非法则输出空）
  local v
  v="$(curl -fsS --max-time 20 "${DL_BASE}/official/$1/VERSION" 2>/dev/null | head -c 64 || true)"
  if printf '%s' "$v" | grep -qE '^[0-9A-Za-z][0-9A-Za-z._-]{0,31}$'; then
    printf '%s' "$v"
  fi
}

# ---------- 同版本换包检测（FINGERPRINT） ----------
# 仅靠 tag/版本号字符串判「要不要同步」有个盲区：上游可以在**不改 tag** 的前提下替换
# release 资产（删了重传、修 bug 后原地覆盖），也可以把 latest 回滚到旧 release。两种情况
# 版本号都不变，need_sync 于是永远跳过，线上镜像和上游实际内容悄悄分叉。
#
# 故除 VERSION 外再存一份 FINGERPRINT：GitHub 类客户端用 release id + 各资产的
# updated_at/size 摘要，能同时覆盖「同 tag 换包」与「latest 回滚」。
#
# 兼容性：线上没有 FINGERPRINT（本改动上线前的存量目录）时**视为匹配**，不触发重同步——
# 否则一上线就会把五个客户端约 1.7GB 全量重下一遍。指纹只在「存在且不同」时才判定需同步。
remote_fingerprint() { # remote_fingerprint <client> → 线上指纹（无则空）
  curl -fsS --max-time 20 "${DL_BASE}/official/$1/FINGERPRINT" 2>/dev/null \
    | head -c 128 | tr -dc '0-9a-f' || true
}

# 从 GitHub release JSON 算指纹：release id + 每个资产的 名字/大小/更新时间。
gh_release_fingerprint() { # gh_release_fingerprint <release-json>
  printf '%s' "$1" | jq -r '
    [ (.id | tostring),
      ( [ .assets[] | "\(.name):\(.size):\(.updated_at)" ] | sort | join(",") )
    ] | join("|")' 2>/dev/null | sha256sum | cut -c1-32
}

# 指纹是否变化（0=变了，需要重新同步）。线上无指纹时返回 1（视为匹配）。
fingerprint_changed() { # fingerprint_changed <client> <new-fp>
  local cur
  cur="$(remote_fingerprint "$1")"
  [ -n "$cur" ] || return 1
  [ "$cur" != "$2" ]
}

# 调用 need_sync 前由客户端函数设置：本次上游内容指纹（空=该客户端不支持指纹）。
# GitHub release 类客户端设它，用于捕捉「同 tag 换包 / latest 回滚」。
SYNC_FP=""

need_sync() { # need_sync <client> <latest> [必须存在的产物名...] → 0=需要同步
  local client="$1" latest="$2" cur miss
  shift 2
  cur="$(remote_version "$client")"
  if [ -z "$cur" ]; then
    log "$client：线上无 VERSION（首次镜像），目标 $latest"
    return 0
  fi
  # CHECK_ONLY 的语义是「校验上游资产可达」，可版本号相等时它过去直接 return 1 跳过，
  # 于是什么都没校验就报通过——正是最需要它工作的稳态下完全失效。故 CHECK_ONLY 不短路。
  if [ -n "$CHECK_ONLY" ]; then
    log "$client：CHECK_ONLY，线上 ${cur:-无} / 上游 $latest，继续校验上游资产可达性"
    return 0
  fi
  if [ "$cur" = "$latest" ] && [ -z "$FORCE" ]; then
    # 版本号相同不等于产物齐全：某个平台的包下载/解析失败时，publish 仍会
    # 推进 VERSION（只要目录里还有别的产物）。此后版本号一直相等，缺的那个
    # 包永远补不回来，对应按钮一直隐藏。所以额外探一次约定产物是否真的在线上，
    # 缺件就照常同步 —— 让每日 CI 能自愈，不必人工 FORCE=1。
    for miss in "$@"; do
      if ! head_ok "${DL_BASE}/official/${client}/${miss}"; then
        log "$client：线上已是 $cur，但缺 $miss，补齐"
        return 0
      fi
    done
    # 版本号与产物都齐了，最后看内容指纹：上游可能在不改 tag 的前提下换过资产。
    if [ -n "$SYNC_FP" ] && fingerprint_changed "$client" "$SYNC_FP"; then
      log "$client：线上仍是 $cur，但上游 release 内容指纹已变（同 tag 换包或 latest 回滚），重新同步"
      return 0
    fi
    log "$client：线上已是 $cur，跳过（FORCE=1 可强制）"
    return 1
  fi
  log "$client：线上 $cur → 目标 $latest"
  return 0
}

upload_file() { # upload_file <local> <client> <cache-control> [content-type]
  local ct_args=()
  [ -n "${4:-}" ] && ct_args=(--content-type "$4")
  aws s3 cp "$1" "s3://${R2_BUCKET}/official/$2/$(basename "$1")" \
    --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" \
    --checksum-algorithm CRC32 \
    --cache-control "$3" "${ct_args[@]}" \
    --no-progress
}

# 上传目录内全部二进制（max-age=300 与后端 5 分钟缓存对齐；同名覆盖故不可 immutable），
# 最后写 VERSION（no-cache）。
publish() { # publish <client> <dir> <version> [期望产物名...]
  local client="$1" dir="$2" version="$3" f n
  shift 3
  if [ -n "$DRY_RUN" ] || [ -n "$CHECK_ONLY" ]; then
    log "$client：DRY_RUN/CHECK_ONLY，不上传（产物：$(ls -m "$dir" 2>/dev/null || echo 无)）"
    return 0
  fi
  # 零产物保护：一个文件都没备齐时不许推进 VERSION（防止把按钮全部隐藏还标新版本号）
  n="$(find "$dir" -maxdepth 1 -type f ! -name VERSION | wc -l)"
  [ "$n" -gt 0 ] || { warn "$client：无任何产物可上传，中止 publish"; return 1; }

  # 完整性闸门：调用方声明本次必须齐备的产物名，缺一个就不许推进 VERSION。
  #
  # 为什么必须有：need_sync 判「该同步吗」只看 VERSION 与线上文件是否存在，而 publish
  # 过去只要目录非空就写新 VERSION。于是「某平台下载失败 → 其余照传 → VERSION 推进」
  # 之后，need_sync 见版本号已相等就直接跳过，缺的那个包永远补不回来——线上从此是
  # 一个自称新版、实际混版的目录，对应按钮长期隐藏且无人告警。
  # 宁可整次失败（CI 红、每日重试），也不要静默的永久混版。
  local want absent=()
  for want in "$@"; do
    [ -f "$dir/$want" ] || absent+=("$want")
  done
  if [ "${#absent[@]}" -gt 0 ]; then
    warn "$client：期望产物缺失，拒绝推进 VERSION（避免线上永久混版）：${absent[*]}"
    warn "$client：本次不上传任何文件，线上保持上一版完整状态；CI 会在下次运行重试。"
    return 1
  fi

  for f in "$dir"/*; do
    [ "$(basename "$f")" = "VERSION" ] && continue
    log "$client：上传 $(basename "$f")（$(du -h "$f" | cut -f1)）"
    upload_file "$f" "$client" "public,max-age=300" || return 1
  done
  printf '%s' "$version" > "$dir/VERSION"
  upload_file "$dir/VERSION" "$client" "no-cache" "text/plain" || return 1
  log "$client：VERSION=$version 已写入"

  # 指纹最后写：它是「本次内容已完整落地」的凭证。若排在 VERSION 之前，中途失败会留下
  # 「指纹已是新版、二进制还是旧版」，下次运行反而因指纹匹配而跳过，把不一致固化下来。
  if [ -n "$SYNC_FP" ]; then
    printf '%s' "$SYNC_FP" > "$dir/FINGERPRINT"
    upload_file "$dir/FINGERPRINT" "$client" "no-cache" "text/plain" || return 1
    log "$client：FINGERPRINT=$SYNC_FP 已写入"
  fi
}

pack_tgz() { # pack_tgz <binary-path> <inner-name> <out.tar.gz>
  local stage
  stage="$(mktemp -d)"
  cp "$1" "$stage/$2"
  chmod 0755 "$stage/$2"
  tar -czf "$3" -C "$stage" "$2"
  rm -rf "$stage"
}

pack_zip() { # pack_zip <binary-path> <inner-name> <out.zip>
  local stage out="$3"
  # zip 只能在 stage 里执行（避免包内带目录层级），故输出路径须先转成绝对路径，
  # 否则 cd 之后相对路径会落到 stage 里、绝对路径会被二次拼接成非法路径。
  case "$out" in /*) ;; *) out="$PWD/$out" ;; esac
  stage="$(mktemp -d)"
  cp "$1" "$stage/$2"
  (cd "$stage" && zip -q -X "$out" "$2") || { rm -rf "$stage"; return 1; }
  rm -rf "$stage"
}

# ---------- Claude Desktop ----------
# GCS 固定 URL 同名覆盖；版本取 Squirrel RELEASES 最末条 full.nupkg（win/mac 通常同步发布，
# 该版本号仅作页面展示）。
#
# 已知局限（上游分发方式决定，无法在本脚本内消除）：版本号只来自 **Windows** 渠道的
# RELEASES，而 Claude.dmg 是一个与版本号无关的固定 URL（同名覆盖）。两者由上游各自更新，
# 因此存在窗口期——RELEASES 已写新版本号、dmg 还是旧包（或反之）。此时 VERSION 会标一个
# 与 dmg 实际内容不符的版本。
# 影响仅限「首页展示的版本号可能短暂领先/落后 mac 包」；由于 dmg 始终是上游最新，用户
# 下到的不会是过期包。要彻底对齐需要上游给 mac 提供带版本号的清单，目前没有。
mirror_claude_desktop() {
  local client=claude-desktop version
  local dir="$WORK/$client"
  version="$(fetch "$OSPREY/nest-win-x64/RELEASES" \
    | grep -oE 'AnthropicClaude-[0-9]+(\.[0-9]+)+-full\.nupkg' | tail -1 \
    | sed -E 's/^AnthropicClaude-|-full\.nupkg$//g')"
  [ -n "$version" ] || { warn "$client：RELEASES 解析不到版本号"; return 1; }
  need_sync "$client" "$version" Claude-Setup-x64.exe Claude.dmg || return 0
  if [ -n "$CHECK_ONLY" ]; then
    head_ok "$OSPREY/nest-win-x64/Claude-Setup-x64.exe" && head_ok "$OSPREY/nest/Claude.dmg" \
      && log "$client：CHECK_ONLY 通过（exe/dmg 可达）" || return 1
    return 0
  fi
  mkdir -p "$dir"
  download "$OSPREY/nest-win-x64/Claude-Setup-x64.exe" "$dir/Claude-Setup-x64.exe" || return 1
  download "$OSPREY/nest/Claude.dmg" "$dir/Claude.dmg" || return 1
  publish "$client" "$dir" "$version" Claude-Setup-x64.exe Claude.dmg
}

# ---------- ChatGPT Desktop ----------
# macOS：oaistatic 上有固定名 dmg 直链（同名覆盖，即最新版），真包 ~78MB，镜像即加速。
# Windows：官方只走 Microsoft Store，没有独立安装包直链。
#   get.microsoft.com/installer/download/<ProductId> 只是 1.4MB 引导器，真负载还是
#   从微软网络拉 —— 镜像它毫无加速意义，故不用。改为经 Store 后端（FE3）解析真实
#   MSIX 直链后下载：fe3-store-url.py 输出的 dl.delivery.mp.microsoft.com 链接是带
#   签名的短时效 URL，只能「取链即下载」，不可存进 manifest，因此必须在此下载并转存 R2。
#   多架构合并为一个 msixbundle 时按 x64 名上传；解析失败只跳过 Windows，不拖累 mac。
# 版本号取 displaycatalog 的包版本（Store 侧权威，mac/win 同步发布）。
mirror_chatgpt() {
  local client=chatgpt version fe3
  local dir="$WORK/$client"
  local win_out=ChatGPT-Setup-x64.msix

  # 版本号来源与 Windows 包解析同一份 FE3 输出；先探一次拿版本。
  # stderr 必须单独分流：脚本把 [fe3] 进度日志写 stderr、JSON 写 stdout，
  # 用 2>&1 合流会让 jq 解析「日志+JSON」直接 parse error，Windows 包被静默跳过。
  local fe3_log="$WORK/fe3-$client.log"
  if ! fe3="$("$HERE/fe3-store-url.py" --product-id "$CHATGPT_STORE_PRODUCT_ID" 2>"$fe3_log")"; then
    warn "$client：FE3 解析失败，Windows 包不可得；详情：$(tail -3 "$fe3_log")"
    fe3=""
  fi
  if [ -n "$fe3" ]; then
    version="$(printf '%s' "$fe3" | jq -r '.version // empty')"
  fi
  # FE3 不可用时退回 displaycatalog 只取版本号（mac 仍可镜像）。
  if [ -z "${version:-}" ]; then
    version="$(fetch "https://displaycatalog.mp.microsoft.com/v7.0/products/${CHATGPT_STORE_PRODUCT_ID}?languages=en-us&market=US&fieldsTemplate=Details" \
      | grep -oE '"PackageFullName":"[^"]*_[0-9]+(\.[0-9]+)+_' | head -1 \
      | grep -oE '[0-9]+(\.[0-9]+)+' | head -1)"
  fi
  [ -n "$version" ] || { warn "$client：解析不到版本号"; return 1; }
  # 只在 FE3 可用时把 msix 列为必需产物：FE3 不可用时它本来就拿不到，
  # 列进去只会让每天重复下载一遍 dmg。
  if [ -n "$fe3" ]; then
    need_sync "$client" "$version" "ChatGPT.dmg" "$win_out" || return 0
  else
    need_sync "$client" "$version" "ChatGPT.dmg" || return 0
  fi

  if [ -n "$CHECK_ONLY" ]; then
    head_ok "$CHATGPT_DMG" || { warn "$client：dmg 不可达"; return 1; }
    if [ -n "$fe3" ]; then
      log "$client：CHECK_ONLY 通过（dmg 可达，FE3 解析出 $(printf '%s' "$fe3" | jq '.packages | length') 个 Windows 包）"
    else
      warn "$client：CHECK_ONLY dmg 可达，但 FE3 不可用（Windows 按钮将隐藏）"
    fi
    return 0
  fi

  mkdir -p "$dir"
  download "$CHATGPT_DMG" "$dir/ChatGPT.dmg" || return 1

  if [ -n "$fe3" ]; then
    local pick url want_size want_sum sum_algo
    # 优先 msixbundle（含多架构），否则取 x64 单架构包。判后缀要用 .filename
    # （真实文件名），不能用 .name —— 后者是 moniker（形如 xxx_x64__2p2nqsd0c76g0），
    # 永远不以 bundle 结尾，拿它选包等于这条分支从不生效。
    pick="$(printf '%s' "$fe3" | jq -c '
      [ (.packages[] | select(.filename | ascii_downcase | endswith("bundle"))),
        (.packages[] | select(.arch == "x64")) ] | .[0] // empty')"
    url="$(printf '%s' "$pick" | jq -r '.url // empty')"
    want_size="$(printf '%s' "$pick" | jq -r '.size // empty')"
    want_sum="$(printf '%s' "$pick" | jq -r '.digest // empty')"
    sum_algo="$(printf '%s' "$pick" | jq -r '.digest_algo // empty')"
    if [ -n "$url" ]; then
      if download "$url" "$dir/$win_out"; then
        # FE3 只给 http:// 直链（同主机的 https 证书主机名不匹配，用不了），
        # 而这是几百 MB 的可执行安装包，明文传输必须自己验完整性：
        # 先比字节数，再比 FE3 给的 SHA1，最后验 zip 结构。三者都过才上传。
        local got_size ok=1
        got_size="$(stat -c%s "$dir/$win_out" 2>/dev/null || echo 0)"
        if [ -n "$want_size" ] && [ "$want_size" != "$got_size" ]; then
          warn "$client：Windows 包大小不符（期望 $want_size，实际 $got_size），丢弃"
          ok=0
        elif [ "$sum_algo" = "SHA1" ] && [ -n "$want_sum" ] \
          && ! printf '%s  %s\n' "$want_sum" "$dir/$win_out" | sha1sum -c --quiet -; then
          warn "$client：Windows 包 SHA1 校验失败，丢弃"
          ok=0
        # MSIX 是 zip 容器：坏包/错页在此暴露，避免把 HTML 当安装包发出去。
        elif ! unzip -tq "$dir/$win_out" >/dev/null 2>&1; then
          warn "$client：Windows 包不是合法 MSIX（zip 校验失败），丢弃"
          ok=0
        fi
        if [ "$ok" = 1 ]; then
          log "$client：Windows 包校验通过（$got_size 字节，SHA1 已核对）"
        else
          rm -f "$dir/$win_out"
        fi
      else
        warn "$client：Windows 包下载失败（短时效链接可能已过期），跳过"
        rm -f "$dir/$win_out"
      fi
    else
      warn "$client：FE3 输出里没有可用的 x64/bundle 包，跳过 Windows"
    fi
  else
    log "$client：FE3 不可用，仅镜像 macOS（Windows 按钮自动隐藏）"
  fi

  # 期望产物集：dmg 恒为必需；msix 仅在「FE3 可用」时必需。
  # 区分两种情形是有意的：FE3 整体不可用（域名被拦、Store 后端变更）时 Windows 包本就
  # 拿不到，此时要求它只会连 mac 一起卡住；而 FE3 明明给出了包却下载/校验失败，属于
  # 真异常，必须拦住 VERSION——否则线上会出现「版本号已是新版、Windows 按钮却隐藏」。
  local -a expect=(ChatGPT.dmg)
  [ -n "$fe3" ] && expect+=("$win_out")
  publish "$client" "$dir" "$version" "${expect[@]}"
}

# ---------- Claude Code ----------
# GCS：stable 文件给版本号，manifest.json 给各平台二进制名与 sha256；
# 下载校验后自行打包为 zip/tar.gz（官方原始分发是裸二进制）。
mirror_claude_code() {
  local client=claude-code version manifest
  local dir="$WORK/$client"
  version="$(fetch "$CC_GCS/stable")"
  printf '%s' "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+' \
    || { warn "$client：stable 内容异常：$version"; return 1; }
  need_sync "$client" "$version" \
    claude-code-windows-x64.zip claude-code-darwin-arm64.tar.gz \
    claude-code-darwin-x64.tar.gz claude-code-linux-x64.tar.gz || return 0
  manifest="$(fetch "$CC_GCS/$version/manifest.json")" || return 1
  [ -n "$manifest" ] || { warn "$client：manifest.json 为空"; return 1; }

  # 平台键 → 目标固定名（linux 用 glibc 版；musl 变体上游另有，如需再加映射）
  local -A MAP=(
    [win32-x64]=claude-code-windows-x64.zip
    [darwin-arm64]=claude-code-darwin-arm64.tar.gz
    [darwin-x64]=claude-code-darwin-x64.tar.gz
    [linux-x64]=claude-code-linux-x64.tar.gz
  )
  mkdir -p "$dir"
  local plat out bin sum url raw
  for plat in "${!MAP[@]}"; do
    out="${MAP[$plat]}"
    bin="$(printf '%s' "$manifest" | jq -r --arg p "$plat" '.platforms[$p].binary // empty')"
    sum="$(printf '%s' "$manifest" | jq -r --arg p "$plat" '.platforms[$p].checksum // empty')"
    if [ -z "$bin" ]; then warn "$client：manifest 缺平台 $plat，跳过 $out"; continue; fi
    url="$CC_GCS/$version/$plat/$bin"
    if [ -n "$CHECK_ONLY" ]; then
      head_ok "$url" && log "$client：CHECK_ONLY $plat 可达" || { warn "$client：$url 不可达"; return 1; }
      continue
    fi
    raw="$WORK/cc-$plat-$bin"
    download "$url" "$raw" || return 1
    if [ -n "$sum" ]; then
      printf '%s  %s\n' "$sum" "$raw" | sha256sum -c --quiet - \
        || { warn "$client：$plat sha256 校验失败"; return 1; }
    fi
    case "$out" in
      *.zip)    pack_zip "$raw" "claude.exe" "$dir/$out" || return 1 ;;
      *.tar.gz) pack_tgz "$raw" "claude" "$dir/$out" || return 1 ;;
    esac
    rm -f "$raw"
  done
  # 四个平台全齐才推进 VERSION：上面遇到 manifest 缺平台会 continue，
  # 若不在此拦住，线上会变成「新版本号 + 少一个平台」的永久混版。
  publish "$client" "$dir" "$version" "${MAP[@]}"
}

# ---------- Codex CLI ----------
# GitHub openai/codex 最新 release（tag rust-vX.Y.Z），资产改名镜像（压缩包内
# 二进制保留官方 target-triple 命名）。
mirror_codex() {
  local client=codex rel version
  local dir="$WORK/$client"
  rel="$(gh_api /repos/openai/codex/releases/latest)"
  version="$(printf '%s' "$rel" | jq -r '.tag_name' | sed -E 's/^rust-v//')"
  printf '%s' "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+' \
    || { warn "$client：tag 解析异常：$version"; return 1; }
  SYNC_FP="$(gh_release_fingerprint "$rel")"
  need_sync "$client" "$version" \
    codex-windows-x64.zip codex-darwin-arm64.tar.gz \
    codex-darwin-x64.tar.gz codex-linux-x64.tar.gz || return 0

  local -A MAP=(
    [codex-x86_64-pc-windows-msvc.exe.zip]=codex-windows-x64.zip
    [codex-aarch64-apple-darwin.tar.gz]=codex-darwin-arm64.tar.gz
    [codex-x86_64-apple-darwin.tar.gz]=codex-darwin-x64.tar.gz
    [codex-x86_64-unknown-linux-musl.tar.gz]=codex-linux-x64.tar.gz
  )
  mkdir -p "$dir"

  # 摘要校验（尽力而为）：上游发布 codex-package_SHA256SUMS，但**实测它只覆盖
  # codex-package-* 那一组产物，不含本脚本镜像的 codex-* 裸二进制包**（两组尺寸不同，
  # 是不同产物而非同名别名；codex-package-* 另外打包了 app-server 等组件）。
  # 另有 .sigstore 只给 linux-musl，darwin/windows 都没有。
  #
  # 所以现状是：上游没有为我们镜像的这四个资产名提供任何官方摘要。这里仍然拉一次清单并
  # 逐个查，能查到就校验——若上游将来补上覆盖，无需改代码即自动生效；查不到则只在最后
  # 汇总成一行说明，不逐个刷 warning（每次跑刷四条会把真正的告警淹掉）。
  local sums_url sums="" verified=0 unlisted=0
  sums_url="$(printf '%s' "$rel" | jq -r \
    '.assets[] | select(.name=="codex-package_SHA256SUMS") | .browser_download_url')"
  if [ -n "$sums_url" ] && [ "$sums_url" != "null" ]; then
    sums="$(fetch "$sums_url" 2>/dev/null || true)"
  fi
  [ -n "$sums" ] || warn "$client：未取到 SHA256SUMS，本次跳过摘要校验"

  local asset out url want
  for asset in "${!MAP[@]}"; do
    out="${MAP[$asset]}"
    url="$(printf '%s' "$rel" | jq -r --arg n "$asset" \
      '.assets[] | select(.name==$n) | .browser_download_url')"
    if [ -z "$url" ] || [ "$url" = "null" ]; then
      warn "$client：release 缺资产 $asset，跳过 $out"; continue
    fi
    if [ -n "$CHECK_ONLY" ]; then
      head_ok "$url" && log "$client：CHECK_ONLY $asset 可达" || { warn "$client：$url 不可达"; return 1; }
      continue
    fi
    download "$url" "$dir/$out" || return 1
    # 摘要按「上游资产名」查，但文件已改名成契约名，故显式传路径给 sha256sum。
    if [ -n "$sums" ]; then
      want="$(printf '%s\n' "$sums" | awk -v n="$asset" '$2==n || $2=="*"n {print $1; exit}')"
      if [ -n "$want" ]; then
        if printf '%s  %s\n' "$want" "$dir/$out" | sha256sum -c --quiet -; then
          log "$client：$asset sha256 校验通过"
          verified=$((verified + 1))
        else
          warn "$client：$asset sha256 校验失败，丢弃该产物"
          rm -f "$dir/$out"
        fi
      else
        unlisted=$((unlisted + 1))
      fi
    fi
  done
  if [ "$unlisted" -gt 0 ]; then
    log "$client：$unlisted 个产物在 SHA256SUMS 中无对应条目（上游只为 codex-package-* 发摘要），未做摘要校验；已校验 $verified 个"
  fi
  # 四个平台全齐才推进 VERSION（缺资产/校验失败都会在此拦住）。
  publish "$client" "$dir" "$version" "${MAP[@]}"
}

# ---------- Gemini CLI ----------
# GitHub google-gemini/gemini-cli release 偶尔只发布 gemini-cli-bundle.zip。该 bundle 是
# 需要 Node.js 的 JavaScript 分发包，不是可直接替代官网按钮所需的 Darwin 原生二进制；这种
# release 保留线上上一版原生产物并成功跳过，避免把「上游未发布该分发形态」误报成同步故障。
# 只有两个 unsigned Darwin 资产都存在时才推进 VERSION；windows/linux 上游暂无原生二进制。
mirror_gemini_cli() {
  local client=gemini-cli rel version
  local dir="$WORK/$client"
  rel="$(gh_api /repos/google-gemini/gemini-cli/releases/latest)"
  version="$(printf '%s' "$rel" | jq -r '.tag_name' | sed -E 's/^v//')"
  printf '%s' "$version" | grep -qE '^[0-9]+\.[0-9]+\.[0-9]+' \
    || { warn "$client：tag 解析异常：$version"; return 1; }
  SYNC_FP="$(gh_release_fingerprint "$rel")"
  # 上游只有 darwin 两个包，windows/linux 本就不存在，不能列为必需产物
  # （否则每天都会判定缺件、白跑一遍）。
  need_sync "$client" "$version" \
    gemini-cli-darwin-arm64.tar.gz gemini-cli-darwin-x64.tar.gz || return 0

  local -A MAP=(
    [gemini-darwin-arm64-unsigned.zip]=gemini-cli-darwin-arm64.tar.gz
    [gemini-darwin-x64-unsigned.zip]=gemini-cli-darwin-x64.tar.gz
  )
  local asset out url zip stage missing=0
  for asset in "${!MAP[@]}"; do
    url="$(printf '%s' "$rel" | jq -r --arg n "$asset" \
      '.assets[] | select(.name==$n) | .browser_download_url')"
    if [ -z "$url" ] || [ "$url" = "null" ]; then
      missing=$((missing + 1))
    fi
  done
  if [ "$missing" -eq "${#MAP[@]}" ]; then
    if printf '%s' "$rel" | jq -e '.assets[] | select(.name=="gemini-cli-bundle.zip")' >/dev/null; then
      # 上游这一版只发 JS bundle：保留线上上一版原生产物是对的，但不能报 OK。
      # 报 OK 会让「上游偶尔跳过一版」和「上游永久停发 Darwin 原生包」看起来一模一样，
      # 后者意味着镜像永久停在旧版本却无人知晓。故标成降级，并把上游版本一并写进汇总，
      # 让「上游最新」与「已镜像版本」的差距在 CI 汇总里直接可见。
      DEGRADED+=("$client")
      add_summary "$client：**降级** — 上游 $version 仅发布 JavaScript bundle，无 Darwin 原生二进制；线上保留 $(remote_version "$client" || echo '未知') 未动"
      log "$client：$version 仅发布 JavaScript bundle、无 Darwin 原生二进制；保留线上版本，跳过同步"
      return 0
    fi
    warn "$client：release 无任何受支持的 Darwin 原生资产"
    return 1
  fi
  if [ "$missing" -ne 0 ]; then
    warn "$client：release 仅有一个 Darwin 架构资产，拒绝发布不完整版本"
    return 1
  fi

  mkdir -p "$dir"
  for asset in "${!MAP[@]}"; do
    out="${MAP[$asset]}"
    url="$(printf '%s' "$rel" | jq -r --arg n "$asset" \
      '.assets[] | select(.name==$n) | .browser_download_url')"
    if [ -n "$CHECK_ONLY" ]; then
      head_ok "$url" && log "$client：CHECK_ONLY $asset 可达" || { warn "$client：$url 不可达"; return 1; }
      continue
    fi
    zip="$WORK/$asset"
    download "$url" "$zip" || return 1
    stage="$(mktemp -d)"
    unzip -q "$zip" -d "$stage" || { warn "$client：$asset 解压失败"; rm -rf "$stage"; return 1; }
    [ -f "$stage/gemini" ] \
      || { warn "$client：$asset 结构异常（未见单文件 gemini）：$(ls "$stage")"; rm -rf "$stage"; return 1; }

    # 架构核验：只确认「有个叫 gemini 的文件」不足以保证内容对得上——上游若把两个架构的
    # 包传错位置，我们会把 x64 二进制当 arm64 发出去，用户拿到的包直接跑不起来。
    # 故按目标文件名期望的架构核对 Mach-O 实际架构。
    local want_arch got_arch
    case "$out" in
      *arm64*) want_arch="arm64" ;;
      *x64*)   want_arch="x86_64" ;;
      *)       want_arch="" ;;
    esac
    if [ -n "$want_arch" ] && command -v file >/dev/null 2>&1; then
      got_arch="$(file -b "$stage/gemini" 2>/dev/null || true)"
      case "$got_arch" in
        *Mach-O*) ;;
        *) warn "$client：$asset 解出的 gemini 不是 Mach-O（实际：$got_arch）"; rm -rf "$stage"; return 1 ;;
      esac
      if ! printf '%s' "$got_arch" | grep -q "$want_arch"; then
        warn "$client：$asset 架构不符（期望 $want_arch，实际：$got_arch），丢弃"
        rm -rf "$stage"
        return 1
      fi
      log "$client：$asset 架构核验通过（$want_arch）"
    fi
    pack_tgz "$stage/gemini" "gemini" "$dir/$out" || { rm -rf "$stage"; return 1; }
    rm -rf "$stage" "$zip"
  done
  log "$client：windows/linux 上游无原生二进制，按契约留空（按钮隐藏）"
  publish "$client" "$dir" "$version" "${MAP[@]}"
}

# ---------- 主流程 ----------

CLIENTS=("$@")
if [ ${#CLIENTS[@]} -eq 0 ] || [ "${CLIENTS[0]}" = "all" ]; then
  CLIENTS=("${ALL_CLIENTS[@]}")
fi

# 白名单前置校验：开工前一次性把全部入参核对完，任一非法就直接退出。
#
# 两层用意：① 参数来自 workflow_dispatch 的自由文本（经 env 传入，见 .github/workflows/
# official-mirror.yml），
# 这里是纵深防御的第二道——即便上游 workflow 将来被改回不安全写法，非白名单值也进不了循环；
# ② 原来的校验写在执行循环里，第 3 个客户端拼错会等前 2 个下载上传完才报错，白跑十几分钟。
for c in "${CLIENTS[@]}"; do
  case "$c" in
    claude-desktop|chatgpt|claude-code|codex|gemini-cli) ;;
    *) echo "未知客户端：$c（可选：${ALL_CLIENTS[*]}）" >&2; exit 2 ;;
  esac
done

# 凭据先去空白再校验：Secret 值若两端带空白（`echo` 存值会补一个 \n，最常见），
# 空白会被原样拼进 aws 的 SigV4 `Credential=<key>/<date>/…` 作用域，
# 新版 urllib3 严格校验 header 值、直接 `Invalid header value` 死掉（实测过一次）。
# 这四个值都是 base64/hex token 或桶名与账号 ID，内部本就不含空白，故整体删空白而非仅裁两端。
# 放在校验之前：这样「只有空白」的值会被归零、被下面的非空校验拦住，而不是带着脏值往下跑。
# 用变量传参不走命令行，避免明文进入进程列表。
strip_ws() { printf '%s' "${1:-}" | tr -d '[:space:]'; }
R2_ACCOUNT_ID="$(strip_ws "${R2_ACCOUNT_ID:-}")"
R2_ACCESS_KEY_ID="$(strip_ws "${R2_ACCESS_KEY_ID:-}")"
R2_SECRET_ACCESS_KEY="$(strip_ws "${R2_SECRET_ACCESS_KEY:-}")"
R2_BUCKET="$(strip_ws "${R2_BUCKET:-}")"
# aws CLI 隐式读 AWS_*（由 CI 从同一批 Secret 映射，见 .github/workflows/official-mirror.yml），
# 与上面的 R2_* 是两组独立变量，必须单独处理并 export 才能传进 aws 子进程。
export AWS_ACCESS_KEY_ID="$(strip_ws "${AWS_ACCESS_KEY_ID:-}")"
export AWS_SECRET_ACCESS_KEY="$(strip_ws "${AWS_SECRET_ACCESS_KEY:-}")"

if [ -z "$DRY_RUN" ] && [ -z "$CHECK_ONLY" ]; then
  for v in "${R2_ACCOUNT_ID:-}" "${R2_ACCESS_KEY_ID:-}" "${R2_SECRET_ACCESS_KEY:-}" "${R2_BUCKET:-}"; do
    [ -n "$v" ] || { echo "缺 R2_* 环境变量（或用 DRY_RUN=1 / CHECK_ONLY=1）" >&2; exit 2; }
  done
  command -v aws >/dev/null || { echo "缺 aws CLI" >&2; exit 2; }
fi

FAILED=()
for c in "${CLIENTS[@]}"; do
  case "$c" in
    claude-desktop|chatgpt|claude-code|codex|gemini-cli) ;;
    *) echo "未知客户端：$c（可选：${ALL_CLIENTS[*]}）" >&2; exit 2 ;;
  esac
  fn="mirror_${c//-/_}"
  # 每轮重置：SYNC_FP 是全局的，不重置会让不支持指纹的客户端（claude-desktop /
  # chatgpt / claude-code）继承上一个客户端的指纹，把别人的凭证写进自己的目录。
  SYNC_FP=""
  log "===== $c ====="
  if "$fn"; then
    # 降级客户端已在函数内写过汇总，不再叠一条 OK（否则同一客户端出现两种状态）。
    case " ${DEGRADED[*]-} " in
      *" $c "*) ;;
      *) add_summary "$c：OK" ;;
    esac
  else
    warn "$c 同步失败（不影响其余客户端）"
    add_summary "$c：**失败**"
    FAILED+=("$c")
  fi
done

log "===== 汇总 ====="
for line in "${SUMMARY[@]}"; do log "$line"; done
if [ ${#DEGRADED[@]} -gt 0 ]; then
  warn "降级客户端（线上完整但未追上上游最新）：${DEGRADED[*]}"
  warn "若长期处于降级，说明上游改变了分发形态，需要更新本脚本的资产映射。"
fi
if [ ${#FAILED[@]} -gt 0 ]; then
  warn "失败客户端：${FAILED[*]}"
  exit 1
fi
