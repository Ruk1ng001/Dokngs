# 定制替换点清单

> 本文件供维护者使用：把本项目从占位品牌（产品名 `cx`、appId `ai.cx.desktop`、
> 内置示例渠道）替换成正式产品所需改动的**全部**替换点，逐项标明「改哪里、怎么改」。
>
> 核心原则：上游源码 `opencode/` 是 git **submodule**，锁定在稳定 tag，永远保持官方
> 原样、只 fetch 不手改。所有定制都在 `brand/` 叠加层里：品牌 / 打包配置走覆盖文件，
> 渠道值走纯配置注入（连补丁都不需要），必须改源码的少数改动才走
> [补丁工作流](#补丁工作流)。

---

## 目录：六个替换点

| # | 替换点 | 载体 | 改动方式 |
|---|--------|------|----------|
| 1 | [品牌名 / productName](#1-品牌名--productname) | `brand/brand.json` | 改一个 JSON 字段 |
| 2 | [appId](#2-appid) | `brand/brand.json` | 改一个 JSON 字段 |
| 3 | [图标](#3-图标) | `brand/icons/` | 替换同名图标文件 |
| 4 | [渠道变量（base_url / key / model）](#4-渠道变量base_url--key--model) | 环境变量 / CI Secret（无补丁） | 改 `channel.env` 或 Secret，不改源码 |
| 5 | [余额接口](#5-余额接口) | 补丁 `01` + `02` | 改余额面板组件 / 注入变量 |
| 6 | [充值 URL](#6-充值-url) | 环境变量 `NEWAPI_TOPUP_URL`（无补丁） | 改 `channel.env` 或 Secret |

所有品牌值集中在单一数据源 `brand/brand.json`，打包覆盖文件
`brand/electron-builder.brand.ts` 从中读取。

---

## 1. 品牌名 / productName

产品显示名当前为 `Dokng`（上游为 `OpenCode`）。

**改动点：`brand/brand.json` 的 `productName` 字段。**

```json
{ "productName": "Dokng" }
```

`brand/electron-builder.brand.ts` import 上游已解析的 `electron-builder.config.ts` 后，
用**前缀替换**把上游 `OpenCode` / `OpenCode Dev` / `OpenCode Beta` 平移到 `productName`
并保留 dev/beta/prod 通道后缀。改这一个字段即可，无需碰源码。

`brand.json` 里另有 `binName`（命令名）、`channelName`（渠道展示名）、`defaultModel`
（默认模型）等非密钥定制值，按需一并调整。

---

## 2. appId

应用标识符当前为占位值 `ai.cx.desktop`（上游为 `ai.opencode.desktop`）。

**改动点：`brand/brand.json` 的 `appId` 字段。**

```json
{ "appId": "ai.cx.desktop" }
```

覆盖文件对 appId 同样走**前缀替换**（`ai.opencode.desktop` → `brand.appId`），并由新
appId 派生 Linux 桌面身份（`extraMetadata.desktopName` / `linux.executableName` /
`StartupWMClass`），保证窗口类与启动器一致。改这一个字段即可。

---

## 3. 图标

**改动点：替换 `brand/icons/` 下的同名文件。**

| 文件 | 用途 |
|------|------|
| `brand/icons/icon.icns` | macOS 图标 |
| `brand/icons/icon.ico` | Windows 图标（`win.icon` / NSIS 安装器图标） |
| `brand/icons/icon.png` | Linux 图标（放目录，electron-builder 自行挑尺寸） |

当前为占位图标（1024×1024）。替换为正式品牌图标后**不用改任何配置**——覆盖文件用
`import.meta.url` 计算图标绝对路径，指向 `brand/icons/` 下固定文件名。

---

## 4. 渠道变量（base_url / key / model）

**改动方式：改环境变量 / `brand/channel.env`（本地）或 CI Secret（线上），不改源码。**

渠道模板 `brand/opencode.template.json` 用 opencode 原生 `{env:VAR}` 占位，运行时替换：

| 占位 | 变量 |
|------|------|
| `{env:NEWAPI_BASE_URL}` | 渠道 API 地址（OpenAI 兼容端点） |
| `{env:NEWAPI_API_KEY}` | 渠道 bearer token / API key |
| `{env:NEWAPI_MODEL}` | 默认模型名 |

换渠道 / 换 key 只改这些变量的值，模板与源码都不动。变量来源见
[README 的「如何配置 new-api 渠道」](README.md#如何配置-new-api-渠道)。

> 桌面余额面板另需在**构建期**把 `NEWAPI_BASE_URL` / `NEWAPI_API_KEY` 注入 renderer
> （浏览器上下文读不到 `process.env`），这由补丁 `02` 的 `renderer.define` 完成，见下。

---

## 5. 余额接口

账户工作台（余额 / 用量 / Keys 管理面板）向 new-api 拉取真实数据。**改动点在两个补丁：**

- **补丁 `09-cx-account-app`**（`brand/patches/09-cx-account-app.patch`）：
  - 账户面板全量实现，落在 `packages/app/src/components/cx-account/`（独立目录、`Cx`
    前缀、对上游现有文件零改动）。数据层 `cx-account-api.ts` 逐 key
    `GET {站点根}/api/app/profile`（`Authorization: Bearer sk-…`，15s 超时）取账户 /
    Key / 今日用量，`GET /v1/models` 取该 key 可用模型；UI 层 `cx-account-dialog.tsx`
    用上游 v2 Dialog 外壳，含加载 / 错误 / 就绪 / 空态与中文降级文案。
  - 早期 desktop 包的独立悬浮面板（原补丁 `01-balance-panel`）已废弃删除，序号 01 空缺。
- **补丁 `02-balance-newapi`**（`brand/patches/02-balance-newapi.patch`）：
  - 改 `packages/desktop/electron.vite.config.ts` —— 全系列**唯一**触碰该文件的补丁，
    统一承载构建期注入：`renderer.define` / `main.define` 的 `NEWAPI_*`、`PRODUCT_NAME`、
    `DEFAULT_LOCALE` 与画布产物拷贝钩子（03/11/17 的 vite 增量已并入，见 manifest [02]）；
  - 改 `packages/desktop/src/renderer/env.d.ts` —— 补 `ImportMetaEnv` 类型声明。

要改余额接口路径 / 单位换算 / 展示，改补丁 `09` 覆盖的 `cx-account-api.ts` /
`cx-account-dialog.tsx`；要改注入的变量集合，改补丁 `02`（并同步
`brand/channel.env.example` 与 `env.d.ts` 声明）。修改后按[补丁工作流](#补丁工作流)
重新导出补丁。

> new-api 用户接口挂**站点根 `/api`** 下（不是 `/v1` 渠道端点），从渠道 `baseURL` 去掉
> 尾部 `/v1` 推导站点根。鉴权统一为 `Authorization: Bearer sk-…`（token 鉴权中间件由
> Key 定位本人 profile，见 `NEW-API-接口文档.md`），面板对失败态做了中文降级提示，
> 不崩溃、不阻塞主程序。

---

## 6. 充值 URL

余额面板「充值」按钮点击后经 `window.api.openLink(url)`（→ 主进程 `shell.openExternal`）
在系统默认浏览器打开充值页面。**改动方式：改环境变量 `NEWAPI_TOPUP_URL`，无需补丁。**

- 优先读注入的 `NEWAPI_TOPUP_URL`；
- 缺省时回退到由 `NEWAPI_BASE_URL` 推导的 new-api 站点根；
- 两者都缺失时按钮禁用并提示「未配置充值地址」。

改充值地址只改 `brand/channel.env`（本地）或 CI Secret（线上）。客户端内不实现任何
支付逻辑。

---

## 补丁工作流

`opencode/` 以 git submodule 锁定在上游 tag，gitlink 必须保持干净才能干净跟随上游
release。凡是必须改动 submodule 内源码的定制，都导出为 `brand/patches/NN-<name>.patch`
（相对 `opencode/` 的 diff），由 CI / 本机在 checkout 后重放。

`brand/patches.manifest` 登记每个补丁覆盖的文件（`--preflight` 会机器校验「manifest 文件
列表 == 补丁实际 diff 文件集」，两边必须完全一致）。当前补丁（详细说明见 manifest 各 section）：

| 补丁 | 功能一句话 |
|------|-----------|
| `02-balance-newapi` | 构建期注入统一承载（`electron.vite.config.ts` 的唯一补丁）+ renderer 凭据注入 |
| `03-lock-channel` | 内核锁定内置渠道：server.ts 按本地 key 合成 provider、写 `OPENCODE_CONFIG`、热重载 |
| `04-channel-keys-store` | 主进程多 key 数据层（electron-store `channelKeys`） |
| `05-channel-keys-ipc` | key 管理专用 IPC + preload 桥（`window.api.channelKeys*`） |
| `06-deeplink-cx` | 运行时品牌名 / appId + `dokng://` 深链协议注册 |
| `07-provider-switch-bridge` | `cx:select-provider` 切换桥 + 新旧布局账户入口接线 |
| `08-self-update-prerelease` | `allowPrerelease=true`（GitHub 回退源能选中 `-dokng.N`） |
| `09-cx-account-app` | 账户面板全量实现（app 包 `cx-account/` 四个新文件） |
| `10-default-locale-zh` | 首启默认中文 locale |
| `11-rebrand` | i18n 运行时品牌名替换 + macOS 菜单 |
| `12-identity` | 系统提示词身份覆盖（"You are Dokng…"） |
| `13-fix-solidjs-dep` | 修上游 `@solidjs/start` 死链依赖（上游修复后可删） |
| `14-splash-brand` | 品牌开屏动画（狗脸 + 爪印） |
| `15-account-icon` | 共享 icon 表新增 `user` / `palette` 图标 |
| `16-wordmark-brand` | 新会话空状态 DOKNG 字标 |
| `17-canvas-embed` | infinite-canvas 画布嵌入（iframe 保活 + 四槽位 + 构建接线） |

画布侧同理：`brand/canvas-patches/` + `brand/canvas-patches.manifest`（01 宿主注入 /
02 嵌入态 UI 与图片代理 / 03 提示词预览渲染 / 04 media 子域改写），应用于
`infinite-canvas/`（基线 `brand/CANVAS_BASE_SHA`）。

### 应用 / 验证补丁（统一走脚本，勿手写循环）

```sh
scripts/apply-patches.sh --preflight   # 零副作用：manifest 一致性 + LF + diff 结构 + 文件集校验
scripts/apply-patches.sh --check       # 临时 worktree 从 BASE_SHA strict 累积重放（与 CI 完全一致）
scripts/apply-patches.sh               # 落地到当前干净的 opencode/ 工作区（构建前重放）
# 画布侧：scripts/apply-canvas-patches.sh（同样三种模式）
```

CI 的 package job 也调用同一脚本重放，逻辑只此一份。

### 导出补丁（改了 submodule 内源码后）

统一走安全导出脚本（先建 pre-N 检查点 worktree，再导出；临时文件 + 结构校验 + 原子替换 +
全量 strict 重放，失败自动恢复旧补丁）：

```sh
scripts/export-patch.sh opencode NN-<name> --base-worktree <pre-N worktree> -- <文件...>
scripts/export-patch.sh canvas   NN-<name> --base-worktree <pre-N worktree> -- <文件...>
```

manifest 必须先有 `[NN-<name>]` section（含文件列表），否则脚本拒绝导出。

### 升级时的补丁冲突（rebase 补丁栈）

`scripts/update.sh` 切到新 tag 后会自动跑 `--check`；若上游改动了补丁覆盖的文件导致
strict 重放失败，用 rebase 脚本把补丁栈整体迁到新基线：

```sh
scripts/rebase-patches.sh plan v1.18.4      # ① 逐补丁重放，冲突落 .rej 停下
# （人工解冲突、删 .rej）
scripts/rebase-patches.sh continue          # ② 从断点继续
scripts/rebase-patches.sh finish            # ③ 重导出漂移补丁 + 刷新 BASE + --check
# 画布补丁栈同理：scripts/rebase-patches.sh --target canvas plan v0.9.1 …
```

> 上游文件的每处改动建议加 `[cx] US-XXX` 注释，便于升级时快速定位并合并。

---

## 打包命令

绕过上游写死 `--config` 的 npm script，直接调 electron-builder 指定品牌覆盖配置：

```sh
cd opencode/packages/desktop
OPENCODE_CHANNEL=prod bun run electron-builder \
  --config ../../../brand/electron-builder.brand.ts
```

无签名凭据时设 `CX_UNSIGNED=1` 出未签名包（关公证 / 移除签名回调）。真实签名待有
证书时去掉该 env 即可。CI 已把这些编排在 `.github/workflows/open-code-release.yml` 的 package job 里
（该单一 workflow 还含 upgrade-opencode / upgrade-canvas 两段每日基线升级，见 README「CI 发布」）。

---

## 发布托管（Cloudflare R2）

产物 + 自更新元数据只上传 Cloudflare R2（出站免费 + CDN，国内下载快），R2 是唯一分发源。
本仓不发 GitHub Release，只保留 tag 作版本台账。

### 涉及的改动点（都已就位）

| 位置 | 作用 |
|------|------|
| `brand/brand.json` 的 `updateBaseUrl` | R2 自定义域 + `/open-code` 路径。已落地为真实域 `https://dl.dokng.com/open-code`（非空、非 `example.com`）即启用 |
| `brand/electron-builder.brand.ts` | `publish` 为单元素 `[generic]` 数组，url 取 `updateBaseUrl`，写进 `app-update.yml`。CI 里 `updateBaseUrl` 无效（空或 `example.com`）会直接抛错中止打包，防止发出永远收不到更新的包 |
| `.github/workflows/open-code-release.yml` 的 release job | finalize `latest*.yml` 后 R2 上传步：把安装包 + 合并后的 yml 推到 R2 `open-code/`。以 `if: env.R2_ACCESS_KEY_ID != ''` 守卫，未配 Secret 时跳过 |
| `brand/download-page/` | Cloudflare Pages 下载落地页（静态，读 R2 的 yml 渲染各平台最新版下载按钮），见其 README |

### 自更新原理

`electron-updater` generic provider 从固定 URL（`updateBaseUrl`）读 `latest*.yml`，按
`version` 字段比对——不经过 GitHub 的 Latest/prerelease 判定，所以 `-dokng.N` 版本能被正常
选中（补丁 `08` 的 prerelease hack 对 generic 是冗余但无害，保留以免动补丁序列）。
`latest*.yml` 里的 `url` 是相对文件名，客户端用「`updateBaseUrl` + 文件名」拼下载地址，故
安装包与 yml 必须放 R2 同一 `open-code/` 目录。

### 启用步骤（Cloudflare 侧手动，本仓库无法代做）

1. **建 R2 桶**（如 `dokng-releases`），在桶设置里开启自定义域，绑 `dl.你的域名`。
2. **建 R2 API Token**（Object Read & Write 权限），记下 Account ID / Access Key ID /
   Secret Access Key。
3. **配 GitHub Secret**（仓库 Settings → Secrets and variables → Actions）：
   - `R2_ACCOUNT_ID`：R2 的 account id
   - `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY`：上一步的 token 凭据
   - `R2_BUCKET`：桶名（如 `dokng-releases`）
4. **改 `brand/brand.json`** 的 `updateBaseUrl` 为 `https://dl.你的域名/open-code`，提交。
5. **（下载页）** 建 Cloudflare Pages 项目连本仓库、构建目录设 `brand/download-page/`，
   绑下载页子域；若下载页与 `dl` 不同域，按 `brand/download-page/README.md` 给 R2 桶加
   CORS 规则允许下载页域 `GET`。

配好后 push 触发一次 release，即可在 R2 桶看到 `open-code/` 下的产物，下载页能解析出最新版。
