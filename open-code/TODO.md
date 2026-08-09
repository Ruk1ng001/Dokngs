# cx 待办清单

> 项目：基于 opencode 桌面端（Electron + SolidJS）的定制跟随版 cx。
> submodule 锁上游 tag，所有定制走 `brand/patches/*.patch`，不改上游源码。
> 本文档只记**尚未完成**的事；已完成的工作见 git 提交历史与 `brand/patches/`。

---

## 已完成（git 历史为准，仅作背景，不再列为待办）

- 多 key 本地存储 + 增删改 + 手动切换（补丁 04/05）
- 每个 key = 一个独立 opencode provider；切换已注册 key 零重启、零打断（走 `cx:select-provider` 事件桥 → `useLocal().model.set`）
- 加/删 key 热重载生效：主进程重写 `OPENCODE_CONFIG` 文件 + `POST /global/dispose`，内核重建 instance，不重启进程（补丁 03/05）
- 内置默认 baseURL、构建期渠道注入（补丁 02/03）
- 首启无 key 引导、`dokng://` 深链一键导入（补丁 06 + 09）
- **账户面板迁入 app 包、改用原生 v2 设计系统（补丁 09）**：面板从 desktop 包迁入
  `packages/app/src/components/cx-account/`（`Cx` 前缀独立目录），外壳用原生
  `@opencode-ai/ui/v2/dialog-v2` + `useDialog()`，配色全走 v2 语义变量（`--v2-*`）、
  跟随明暗主题、与原生设置页视觉统一（不再自绘浮层 / 不再硬编码颜色）。账户按钮
  （补丁 07 layout.tsx）点击 `dialog.show(() => <CxDialogAccount/>)`；首启无 key 时
  （补丁 07 FR-3.6）自动弹出面板并展开 `AddKeyForm`（仅 desktop、仅一次）；`dokng://`
  导入深链复用 opencode 既有 deep-link 分发，在 layout.tsx 的 `handleDeepLinks` 内解析后
  弹 `CxDialogImport` 确认框（自闭合，走 `useDialog().close()`）。`AddKeyForm` 隐藏可选
  baseURL 输入（FR-3.5），新增 key 的 `baseURL` 固定空串、走构建期内置 `NEWAPI_BASE_URL`
  回退。跨包类型缺口（`window.api.channelKeys*` / `import.meta.env.NEWAPI_*`）在 cx 目录内
  用局部声明 + 断言访问器解决，不碰上游类型文件。旧 desktop 面板 `balance-panel.tsx`
  与 `renderer/index.tsx` 挂载已删除（原补丁 01 作废）。双包 typecheck 通过、补丁可干净重放。
- cx 自动更新指向本仓库发布（补丁 08 + open-code-release.yml + brand 配置）
- macOS 分架构原生打包（修 pty.node 崩溃）
- **默认语言改中文（补丁 10 + `brand.json` `defaultLocale`）**：desktop renderer 入口
  `loadLocale` 在本地无语言存储时加载并返回品牌配置的默认 locale（缺省 `"zh"`），
  经 `electron.vite.config.ts` 构建期注入 `import.meta.env.DEFAULT_LOCALE`；已存储语言时
  行为不变，用户选择不被覆盖（US-001 / US-002 / US-003）。
- **new-api `GET /api/app/profile` 后端端点（new-api 仓库，非 opencode 补丁层）**：走 token
  鉴权中间件由 `sk-` 定位本人 profile，`user_id` 只从 token 记录派生、不读任何入参；返回
  `username`/`avatar`/`quota`（=`user.quota + user.used_quota`）/`used_quota`/`token_remain`/
  `token_used`/`token_used_today`/`unlimited`，可选 `used_today`（聚合失败时省略，App 端显示「—」）。
  客户端 `cx-account` 面板已联调闭合链路（US-004 / US-005 / US-006 / US-007）。
- **`/v1/models` 已按 token `model_limits` 过滤**：经查 new-api 源码确认 `GET /v1/models` 按
  key 返回该 key 可用模型（`TokenAuth` 注入 model_limits → `ListModels` 过滤），App 端切换 key
  直接用 `/v1/models`，无需新增 `/api/app/models`（US-008）。
- **账户面板 UI 审查（US-012.5，无头可查项已完成）**：修复三处实缺陷——① CSS 选择器与
  TSX 的 `data-slot` 全面对齐（此前 CSS 全用类选择器、TSX 用 data-slot，几乎全部规则失配，
  面板近乎无样式）；② `AddKeyForm` 隐藏 baseURL 输入（FR-3.5）；③ 补齐首启无 key 自动弹出
  （FR-3.6）。并核对：`aria-label` 全覆盖、状态分支（加载/错误/就绪/切换/空态）齐全、
  可视文案无英文残留、15 个 `--v2-*` 变量与 `progress-circle-v2` / `dialog-body` 的
  data-slot 均在上游 v2 定义中实在。**实机目视项待跑**（见待办第 2 节）。

---

## 待办

### 1. 自动更新端到端验证（程序化预检已过；三平台实机待跑）

自更新链路（补丁 08 + publish 源 + latest*.yml 合并）代码已就位，全链路程序化预检全绿：

- ✅ 更新源指向本仓库：`brand/electron-builder.brand.ts` 的 `publish` 覆盖上游 `anomalyco/opencode` → `Ruk1ng001/opencode-desktop`（打进产物 `app-update.yml`）；全仓无残留官方更新源引用 → 不弹官方 opencode 更新。
- ✅ feed 解析：`updater.ts` `allowPrerelease=true` 走 releases.atom 按 `dokng` 分量匹配 `-dokng.N`；线上 atom feed 实测可解出最新 dokng tag，旧→新数值递增可检出。
- ✅ 自更新载体：完整三平台 release 的 mac=zip / win=exe / linux=AppImage 全部可达，`latest*.yml`（sha512/size）完整。
- ⚠️ **发布态注意**：早期 cx.8/cx.9 是「临时只打 Windows+mac-x64」时期产物，缺 linux / mac-arm64。实机验证必须用恢复四平台矩阵后**连发的两个完整三平台版本**。

**仍未完成（不可在无头 CI/服务器环境替代）**：三平台真机实测（装旧版 → 发新版 → 肉眼确认检测/下载/安装/启动新版本；mac 走 zip、win 走 exe、linux 走 AppImage）。三平台全部通过前不推正式发布。

### 2. 账户面板实机目视审查（US-012.5 剩余项）

无头环境可机检的项已在「已完成」段完成。剩余需真机 `npm run dev` 目视确认：

- **本次全面重构了 CSS**（类选择器 → data-slot），务必目视确认面板两栏布局、环形图、
  key 卡片列表在真机正确渲染、无错位。
- 对比度、窄窗口/最小窗口下文案换行与不溢出、滚动正常。
- 首启自动弹出（FR-3.6）、隐藏 baseURL 后表单无残留空隙（FR-3.5）在真机的实际观感。
- 各交互状态（加载 / 空态 / 错误 404·401·500 / `unlimited` / `used_today` 缺失显「—」）在真实或模拟数据下的渲染。

### 3. 推送发布（前置门槛未全过，暂不推送正式版）

推送前置门槛：双包 typecheck ✅（desktop/app 各 rc=0）/ 补丁 0 冲突重放 ✅ / CI 4 平台矩阵 ✅ / 敏感值不入库 ✅ 均已通过。未过两项：**账户面板实机目视审查（待办第 2 节）**、**自动更新三平台实机验证（待办第 1 节）**——两者都需真机、无头服务器无法替代完成。两项门槛过关后方可走特性分支推送 + CI 自动合并发布正式版流程。

---

## 集成第二上游：infinite-canvas 画布（已完成，2025-07 落地）

> 本节原为集成规划（待办 4/5/6），现已全部落地，留此存档并记录最终形态；
> 真实未办事项只剩上方「待办」第 1/2/3 节（三平台真机验证、面板目视审查、正式版推送门槛）。

**落地形态（与原规划的对应关系）：**

- **submodule + 补丁层**（原待办 6）：`infinite-canvas/` 已入 `.gitmodules`（第二 submodule），
  基线锁 `brand/CANVAS_BASE_TAG` / `CANVAS_BASE_SHA`；画布定制走 `brand/canvas-patches/`
  （01 宿主注入 / 02 嵌入态 UI 与图片代理 / 03 提示词预览渲染 / 04 media 子域改写）+
  `canvas-patches.manifest`；脚本 `scripts/update-canvas.sh`、`scripts/apply-canvas-patches.sh`、
  `scripts/rebase-patches.sh --target canvas` 齐备；CI 升级链路为 `open-code-release.yml` 的
  `upgrade-canvas` job（每日检测、strict 重放 + `VITE_BASE=/canvas/` 构建验证，只推 main 不发版）。
- **opencode 侧嵌入**（原待办 4）：补丁 `17-canvas-embed`——`CanvasHost` 常驻 NewLayout
  保活 iframe（`oc://renderer/canvas/index.html`，切走仅 display:none）；账户面板每 key 卡片
  四槽位按钮（生图/视频/文本/音频，`cx-canvas-slots.ts` 持久化）；`dokng:canvas-ready` 握手后
  postMessage 投递 key（targetOrigin 严格 `oc://renderer`）；构建接线 `build-canvas.ts` +
  vite `dokng:copy-canvas` writeBundle 钩子（vite 增量已统一收敛进补丁 02）。
- **画布侧适配**（原待办 5）：canvas 补丁 01——HashRouter（真机实测 basename 方案 404 的教训）、
  `dokng:canvas-config` 注入链路、**apiKey 不落盘**（嵌入态 `partialize` 剥离，key 只驻内存，
  每次进画布由宿主重投——决策按原拍板执行）。


## 上游基线

> 仓库：`https://github.com/anomalyco/opencode.git`（submodule `opencode/`）
> 基线 tag / SHA：见 `brand/BASE_TAG` / `brand/BASE_SHA`
> 哲学：submodule 锁上游 + brand 薄叠加层 + 补丁不改源码
