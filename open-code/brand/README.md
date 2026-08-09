# brand/ — 品牌叠加层

本目录承载所有对 opencode 的定制内容，与上游源码（`opencode/` submodule）**物理隔离**。
上游更新只需同步 submodule，本目录不受影响；本目录的改动也不会污染上游源码，便于跟踪与重放。

## 目录结构

| 路径 | 作用 | 是否含真实值 |
|---|---|---|
| `BASE_TAG` / `BASE_SHA` | opencode 上游基线双文件：锁定的上游 tag 与对应 commit SHA，二者同步更新。 | 否 |
| `CANVAS_BASE_TAG` / `CANVAS_BASE_SHA` | infinite-canvas（第二上游，画布）基线双文件，机制同上。 | 否 |
| `brand.json` | 品牌配置：产品名、appId、命令名、渠道展示名、默认模型、默认 locale 等**非密钥**定制值，是品牌值的单一数据源。`defaultLocale` 未配置或不是字符串时，构建期回退为 `zh`。 | 否 |
| `electron-builder.brand.ts` | 品牌打包覆盖：import 上游 `electron-builder.config.ts` 后 spread 覆盖 `productName` / `appId` / 图标路径 / 由 appId 派生的 Linux 身份，不碰上游源码。 | 否 |
| `opencode.template.json` | 内置渠道模板：opencode.json 格式，`provider.newapi` 走 `@ai-sdk/openai-compatible`（命中 `/v1/chat/completions`），含 opencode 原生 `{env:NEWAPI_BASE_URL}` / `{env:NEWAPI_API_KEY}` / `{env:NEWAPI_MODEL}` 占位，运行时替换。 | 否（仅占位符） |
| `channel.env.example` | 渠道环境变量**示例**：列出所需变量名与假值，复制为 `channel.env` 后填真实值本地使用。 | 否（仅示例值） |
| `icons/` | 品牌图标资源（`icon.icns` / `icon.ico` / `icon.png`，当前为占位图标）。 | 否 |

## 品牌打包（改名 / 图标 / appId）

`electron-builder.brand.ts` 从 `brand.json` 读取 `productName` / `appId`，import 上游
已解析的 `electron-builder.config.ts` 后 spread 覆盖品牌字段：

- `appId`：上游恒以 `ai.opencode.desktop` 开头（prod 无后缀，dev/beta 带 `.dev` / `.beta`），
  覆盖层用**前缀替换**平移到 `brand.appId` 并保留通道后缀。
- `productName`：上游形如 `OpenCode` / `OpenCode Dev` / `OpenCode Beta`，同样按前缀替换。
- 图标：`mac.icon` → `icons/icon.icns`、`win.icon` / `nsis.installerIcon` → `icons/icon.ico`、
  `linux.icon` → `icons/`（目录，electron-builder 自行挑尺寸）。路径用 `import.meta.url`
  取绝对路径，不受调用 CWD 影响。
- Linux 身份：`extraMetadata.desktopName` / `linux.executableName` / `StartupWMClass`
  均由新 `appId` 派生，同步覆盖以保持窗口类与启动器一致。

打包命令（在 `opencode/packages/desktop/` 下，`--config` 指向本覆盖文件）：

```sh
cd opencode/packages/desktop
OPENCODE_CHANNEL=prod bun run electron-builder --config ../../../brand/electron-builder.brand.ts
```

> 类型检查：覆盖文件本身通过 `Configuration` 类型检查（`strict` 模式）。上游 `getConfig()`
> 未标注返回类型，`publish.provider` 等字面量被推断为宽泛 `string`，与 `Publish` 联合类型
> 不兼容——覆盖层将 import 的 base 断言回 `Configuration` 收窄类型即可，运行时结构不变。

### 技术风险 #2：`--config` 能否干净覆盖（最小补丁记录）

上游 `packages/desktop/package.json` 的 `package` 系列脚本**写死**了配置路径：

```json
"package":       "electron-builder --config electron-builder.config.ts",
"package:mac":   "electron-builder --mac --config electron-builder.config.ts",
"package:win":   "electron-builder --win --config electron-builder.config.ts",
"package:linux": "electron-builder --linux --config electron-builder.config.ts"
```

因此**不能**通过 `bun run package` 走品牌覆盖。两条落地路径：

1. **推荐（零补丁）**：CI / 本地打包**绕过 npm script**，直接调 electron-builder 并显式指定
   `--config ../../../brand/electron-builder.brand.ts`（见上方命令）。品牌覆盖文件 import 上游
   config 后 spread，`electron-builder` 支持 `.ts` 配置，完全不改上游源码即可干净覆盖。
2. **需要 `bun run package` 时的最小补丁**：仅当必须复用上游 npm script 时，改
   `package.json` 中 4 行 `--config` 目标为 `../../../brand/electron-builder.brand.ts`
   （或经环境变量参数化）。这是唯一需要触碰上游的改动，属**单文件 4 行**的最小补丁，
   与「不改源码」哲学冲突，故默认走路径 1、不引入此补丁。

## 真实值从哪来

渠道真实值（API 地址、token）**绝不进 git**：

- **本地打包**：复制 `channel.env.example` → `channel.env`，填入真实值。`channel.env` 已被根 `.gitignore` 忽略。
- **CI 打包**：由 GitHub Actions Secret 以同名环境变量注入，同样不落 git、不进日志。

渠道模板 `opencode.template.json` 直接使用 opencode **原生** `{env:NEWAPI_BASE_URL}` /
`{env:NEWAPI_API_KEY}` / `{env:NEWAPI_MODEL}` 占位：opencode 运行时在加载配置时会把
`{env:VAR}` 就地替换成对应环境变量的值（见上游 `packages/opencode/src/config/variable.ts`），
**无需额外渲染脚本**。CI 打包时把这三个变量以 Secret 注入即可，模板本身不含任何真实值。

## 本机验证

模板可直接作为 opencode 配置使用，注入环境变量后启动即连上内置渠道：

```sh
# 1. 复制示例并填入真实值（channel.env 已被 .gitignore 忽略）
cp brand/channel.env.example brand/channel.env

# 2. 把 channel.env 里的变量导出到当前 shell
set -a && . brand/channel.env && set +a

# 3. 用 OPENCODE_CONFIG 指向模板启动；运行时会原生替换 {env:VAR}
OPENCODE_CONFIG="$PWD/brand/opencode.template.json" opencode
```

启动后 `/models` 应能看到内置渠道与默认模型，无需任何手动配置。

## 补丁维护与发布前验证

补丁是可执行的 unified diff，不应直接编辑 `.patch` 正文中的 `+` / `-` / 空上下文行。要修改
补丁内容，应在对应的 pre-N 检查点 worktree 中修改源码，再通过安全导出脚本重新生成：

```sh
scripts/export-patch.sh opencode 17-canvas-embed --base-worktree .tmp-patch -- \
  packages/app/src/pages/canvas-embed.tsx packages/app/src/pages/layout-new.tsx

scripts/export-patch.sh canvas 02-embed-ui --base-worktree .tmp-canvas-patch -- \
  web/src/services/api/prompts.ts
```

导出脚本先写临时文件，验证 patch 语法后原子替换，再运行完整 strict 累积重放；失败会恢复旧补丁。
共享文件的 worktree 检查点流程见记忆/定制文档：先应用前序补丁并提交 pre-N baseline，再复制最终文件。

发布或提交前使用：

```sh
# 零副作用快速预检：manifest 集合与文件集、LF 行尾、unified diff 语法（可捕获 corrupt patch）
scripts/apply-patches.sh --preflight
scripts/apply-canvas-patches.sh --preflight

# 从锁定基线在临时 worktree strict 累积重放，与 Release CI 完全一致
scripts/apply-patches.sh --check
scripts/apply-canvas-patches.sh --check

# 仅用于诊断上游漂移；即使成功，也不代表 strict 发布路径可通过
scripts/apply-patches.sh --check-3way
scripts/apply-canvas-patches.sh --check-3way
```

`--preflight` 除补丁语法外还做两类机器校验：

- **manifest 文件集**：每个 `[section]` 声明的文件列表必须与该补丁实际 diff 的文件**完全一致**
  （`rebase-patches.sh finish` 按 manifest 文件列表重导出漂移补丁，列表缺文件会静默丢 hunk，
  故 manifest 不是纯文档、是机器闸门）；
- **channelProviderId 一致性**（仅 opencode 侧）：该函数在主进程数据层（补丁 04）与 renderer
  数据层（补丁 09）各有一份副本，实现必须逐字一致，否则切 key 事件匹配不到 provider。

升级基线用 `scripts/update.sh` / `scripts/update-canvas.sh`，二者在切换 tag 后会**自动跑对应
`--check`**：不通过时基线保持已更新（不回滚）、以非 0 退出，提示进入 rebase 流程：

```sh
scripts/rebase-patches.sh plan <新tag> && … && scripts/rebase-patches.sh finish
scripts/rebase-patches.sh --target canvas plan <新tag>   # 画布补丁栈（状态目录独立，互不干扰）
```

父仓库 `.gitattributes` 固定 `*.patch text eol=lf`，避免 Windows checkout 把补丁转成 CRLF；
补丁文件不得含 NUL 等二进制字节（否则 grep / 密钥扫描会把补丁当二进制静默跳过）。
`brand/patches.manifest` 与 `brand/canvas-patches.manifest` 的执行顺序仍由 patch 目录下的
`NN-*.patch` 文件名决定。约定：`packages/desktop/electron.vite.config.ts` 的全部改动统一收敛在
补丁 `02-balance-newapi`（全系列唯一触碰该文件的补丁），后续需要新增构建期注入时改 02，
不要在其它补丁里再叠改该文件。

## 安全约束

- 本目录**不含任何真实密钥或个人 baseURL**——只有占位符与假值示例。
- 换渠道 / 换 key：只改 `channel.env`（本地）或 CI Secret（线上），模板与源码都不动。
