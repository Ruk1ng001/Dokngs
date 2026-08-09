# Dokngs

三个产品的 monorepo：两个上游 fork 的品牌化定制 + 一份官方客户端镜像。

| 目录 | 是什么 | 上游 |
|------|--------|------|
| [`cc-switch/`](cc-switch/) | Claude Code / Codex 配置切换器，品牌名 **CC Switch**（Tauri + pnpm） | [farion1231/cc-switch](https://github.com/farion1231/cc-switch) |
| [`open-code/`](open-code/) | AI 编码助手桌面端，品牌名 **Dokng**（Electron + Bun） | [anomalyco/opencode](https://github.com/anomalyco/opencode) + [basketikun/infinite-canvas](https://github.com/basketikun/infinite-canvas) |
| [`official/`](official/) | 官方客户端镜像同步（Claude Desktop / ChatGPT / Claude Code / Codex / Gemini CLI） | 各厂商官方分发 |

## 定制模式

两个产品同构：**上游代码作 submodule 只读引入，定制全部放 `brand/` 覆盖层**，
不在 submodule 里直接改代码。

```
<product>/
  upstream/ 或 opencode/     ← submodule，钉在 brand/BASE_SHA 记录的 commit
  brand/
    BASE_TAG / BASE_SHA      ← 基线台账（tag 决定版本号，sha 决定构建内容）
    patches/*.patch          ← 必须改上游源码时的补丁，按序号 strict 重放
    patches.manifest         ← 补丁台账：每个 patch 声明它改哪些文件，CI 强校验
  scripts/
    apply-patches.sh         ← 重放补丁；--preflight 只验台账，零副作用
    update.sh                ← 升级基线：换 tag/sha + 重放补丁 + 验证
    next-version.sh          ← 算下一个发布版本号
```

补丁「strict 重放」的含义：升级基线时补丁必须干净应用，冲突即中止并报漂移诊断，
不允许 3way 兜底静默合并 —— 静默合并过的补丁没人会去复核。

## 发布：只打 tag，不发 Release

**本仓不创建 GitHub Release。** tag 是唯一的版本台账，
[Cloudflare R2](https://dl.dokng.com) 是唯一的分发与自更新源。

版本号方案（两个产品各自独立递增）：

| 产品 | 形如 | 含义 |
|------|------|------|
| cc-switch | `v3.19.2-ccs.1` | 上游 tag `v3.19.2` 的第 1 次 ccs 发布 |
| open-code | `v1.18.15-dokng.2` | 上游版本 `1.18.15` 的第 2 次 dokng 发布 |

`N` 由 `next-version.sh` / `next-dokng-version.sh` 读「已有 tag 里同基线的最大 N」+1 得出。
清空历史时必须给线上在跑的版本补一个同名 anchor tag，否则 N 会算回 1 并覆盖线上版本。

### R2 布局

两个产品同构：**元数据在产品根固定 URL（禁缓存），安装包下沉版本子目录（immutable 长缓存）**。

```
dl.dokng.com/
  cc-switch/
    latest.json                  ← Tauri updater 轮询这个固定 URL（no-cache）
    3.19.2-ccs.1/                ← 安装包 + .sig（immutable）
  open-code/
    latest.yml, latest-mac.yml,
    latest-linux.yml             ← electron-updater 轮询（no-cache）
    1.18.15-dokng.2/             ← 安装包 + blockmap（immutable）
  official/
    <client>/VERSION             ← 镜像版本状态，也是官网展示的版本号
    <client>/<固定文件名>         ← 同名覆盖，文件名契约见 official/scripts/
  _staging/<product>/<run_id>/   ← 跨 job 产物中转，发布完即清；3 天前的陈旧前缀顺带回收
```

发布闸门顺序（三个产品一致，勿调换）：上传安装包 → 逐个 `head-object` 校验 → 才覆盖根元数据
→ 最后清理旧版本。元数据一旦指向不存在的包，客户端就会拿到 404 更新。

## Workflows

| 文件 | 触发 | 干什么 |
|------|------|--------|
| `cc-switch-release.yml` | push tag `v*-ccs.*` / 手动 | 三平台出包 → 上传 R2 |
| `cc-switch-upgrade.yml` | 每日 16:37 UTC / 手动 | 升级 cc-switch 基线，推 main + 打 tag |
| `open-code-release.yml` | push tag `v*-dokng.*` / 每日 16:23、17:47 UTC / 手动 | 基线升级 + 四平台出包 → 上传 R2 |
| `official-mirror.yml` | 每日 18:53 UTC / 手动 | 同步五个官方客户端到 R2 `official/` |

四个定时任务错峰排布，互不抢 runner；concurrency group 全部带产品前缀，
两个产品的流水线互不排队、互不取消。

**monorepo 约定**：每个 job 都设 `defaults.run.working-directory: <product>`，
所以 `run:` 里的路径照产品内相对路径写。两类例外必须显式处理 ——
`uses:` 步骤的路径参数（基准恒为 workspace 根，不受 `defaults` 影响）要带 `<product>/` 前缀；
step 级 `working-directory` 一律写 `${{ github.workspace }}/...` 绝对路径。

**submodule 按需初始化**：checkout 一律 `submodules: false`，各 job 只 `git submodule update --init`
自己需要的那个路径。用 `recursive` 会让每个 job 都拉全部三个 submodule（约 571M）。

## 所需 Secret

| Secret | 必需 | 用途 |
|--------|------|------|
| `R2_ACCOUNT_ID` / `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` / `R2_BUCKET` | 是 | R2 上传（缺任一则 R2 步骤跳过，产物只留在 artifact 里，等于没发布） |
| `RELEASE_PAT` | 是 | 基线升级 job 推 tag 用。**必须是 PAT**：`GITHUB_TOKEN` 推的 tag 不触发任何 workflow，用它会让自动升级打完 tag 后发布流水线不启动 |
| `TAURI_SIGNING_PRIVATE_KEY` | cc-switch 必需 | Tauri updater 的 minisign 签名，缺了客户端拒绝安装更新 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 否 | 私钥有密码时才需要 |
| `NEWAPI_BASE_URL` / `NEWAPI_API_KEY` / `NEWAPI_MODEL` / `NEWAPI_TOPUP_URL` | open-code 必需 | 内置渠道配置，打包期注入，绝不入库 |

私钥文件（`cc-switch/brand/updater-private.key`）永不提交，见 `.gitignore`。

## 本地上手

```bash
git clone --recurse-submodules git@github.com:Ruk1ng001/Dokngs.git
cd Dokngs

# 只要某一个产品时按需初始化即可
git submodule update --init cc-switch/upstream

# 验补丁台账（零 worktree 副作用）
cd cc-switch && bash scripts/apply-patches.sh --preflight
```

各产品的详细定制说明、补丁清单、发布细节见各自目录下的 `README.md` / `CUSTOMIZATION.md`。
