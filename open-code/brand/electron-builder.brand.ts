import path from "node:path"
import { fileURLToPath } from "node:url"

import type { Configuration } from "electron-builder"

import baseConfig from "../opencode/packages/desktop/electron-builder.config.ts"
import brand from "./brand.json" with { type: "json" }

// 上游 `getConfig()` 未标注返回类型，`publish.provider` 等字面量被推断为宽泛的
// `string`，与 electron-builder 的 `Publish` 联合类型不兼容。断言回 `Configuration`
// 以对齐类型（运行时结构不变，仅收窄类型）。
const base = baseConfig as Configuration

// 品牌覆盖层：import 上游已解析的 electron-builder 配置后 spread 覆盖，
// 只改品牌相关字段（productName / appId / 图标路径 / 由 appId 派生的 Linux 身份），
// 不修改上游源码。上游按 OPENCODE_CHANNEL 输出 dev/beta/prod 三通道，
// 这里保留各通道后缀（用前缀替换而非写死单值）。

const brandDir = path.dirname(fileURLToPath(import.meta.url))
const iconsDir = path.join(brandDir, "icons")

// 上游 appId 恒以 "ai.opencode.desktop" 开头，可能带 ".dev" / ".beta" 后缀（prod 无后缀）。
// 替换前缀即可平移到品牌 appId 并保留通道后缀。
const UPSTREAM_APP_ID_PREFIX = "ai.opencode.desktop"
const UPSTREAM_PRODUCT_NAME = "OpenCode"

const brandedAppId = (base.appId ?? UPSTREAM_APP_ID_PREFIX).replace(UPSTREAM_APP_ID_PREFIX, brand.appId)
// 上游 productName 形如 "OpenCode" / "OpenCode Dev" / "OpenCode Beta"。
const brandedProductName = (base.productName ?? UPSTREAM_PRODUCT_NAME).replace(UPSTREAM_PRODUCT_NAME, brand.productName)

// 上游 artifactName 写死 "opencode-desktop-${os}-${arch}.${ext}"，产物文件名带 opencode-desktop
// 前缀。用 brand.json 的 binName 替换前缀（与读 appId/productName 同源），产物如
// dokng-linux-x86_64.AppImage。注意 ${os}/${arch}/${ext} 是 electron-builder 的模板占位符
// （非 JS 插值），用普通字符串拼接保留字面量，仅 JS 侧替换 binName 前缀。
const brandedArtifactName = brand.binName + "-${os}-${arch}.${ext}"

// 无签名凭据时的降级开关（CI 首跑 / 本地验证用）。CX_UNSIGNED=1 时：
//   - macOS：关闭公证（notarize）与 hardenedRuntime，用 ad-hoc 签名（identity:"-"）而非
//     完全不签名（identity:null）。原因：macOS 自更新走 Squirrel.Mac，它在安装前对「正在
//     运行的 app」调 SecCodeCopySelf 读代码签名；identity:null 出来的包完全没有签名，读取
//     失败抛 "Could not get code signature for running application"，更新在 ready⇄installing
//     间死循环、永远装不上。ad-hoc（codesign -s -，本地自签、无需任何 Apple 证书）让 app
//     带上可读签名即可通过该校验。hardenedRuntime 仍关闭（ad-hoc + hardenedRuntime 需额外
//     library-validation entitlement，否则启动崩）。注意：ad-hoc 修复的是「读不到签名」，
//     Gatekeeper 首次打开仍需用户右键放行；要彻底免右键 + 稳定自更新仍需 Apple Developer ID。
//   - dmg：关闭 sign；
//   - Windows：移除上游自定义 signtoolOptions（其内部会调 Azure Trusted Signing，
//     无 Azure 凭据必然失败），产出未签名 nsis .exe。
// 默认（未设该 env）行为与上游一致：走完整签名 / 公证链路（需相应凭据）。
const unsigned = process.env.CX_UNSIGNED === "1"

// [cx] 自更新源：Cloudflare R2（generic provider，出站免费 + 全球 CDN）。
//   - generic url 来自 brand.json 的 updateBaseUrl（如 https://dl.<域名>/open-code），
//     与从 brand.json 读 appId/productName 的模式一致，域名不散落硬编码。
//   - generic provider 直接读固定 URL 的 latest*.yml、按 version 比对，不经 GitHub 的
//     prerelease 判定；补丁 08（allowPrerelease=true）对 generic 无害冗余、保留。
// channel:"latest" 与 updater.ts 的 autoUpdater.channel="latest" 对齐（生成/查找 latest*.yml）。
// CI 打包 --publish never（只出产物 + dist 里的 latest*.yml），上传由 release job 推 R2。
//
// [monorepo] 原先是 [generic, github] 双源（GitHub Release 作回退）。本仓不再发 Release，
//   回退源恒不存在，故删掉 github 项 —— 保留它只会让客户端在 R2 短暂不可达时多打一轮
//   404 请求、把「暂时取不到更新」的日志噪音伪装成「有源但没版本」。R2 现为唯一更新源。
//
// [monorepo] updateBaseUrl 缺省 / 占位（example.com）时的退化路径：原先回退到纯 GitHub
//   publish，现在无 GitHub 源可退，故保留 generic 结构但指向占位 url。这只影响本地实验性
//   构建（打出的包自更新查不到源，等价于「不自更新」），不影响 CI —— CI 用的 brand.json
//   已填真实域名，且下面的断言在 url 仍是占位时直接让打包失败，防止误发不能自更新的包。
const updateBaseUrl = (brand as { updateBaseUrl?: string }).updateBaseUrl?.trim() ?? ""
const useR2 = updateBaseUrl.length > 0 && !updateBaseUrl.includes("example.com")
// CI 里必须是真实 R2 域名：否则打出的包 app-update.yml 指向占位 url，装机后永远收不到
// 更新，而这种包一旦上架 R2 就只能靠用户手动重装来纠正。就地失败远比事后补救便宜。
if (!useR2 && process.env.CI === "true") {
  throw new Error(
    `[brand] brand.json 的 updateBaseUrl 无效（当前：${updateBaseUrl || "<空>"}）。` +
      "本仓以 Cloudflare R2 为唯一自更新源，CI 打包必须填真实域名（如 https://dl.dokng.com/open-code）。",
  )
}
const brandedPublish = [
  {
    provider: "generic",
    url: useR2 ? updateBaseUrl : "https://example.com/open-code",
    channel: "latest",
  } as const,
]

const config: Configuration = {
  ...base,
  appId: brandedAppId,
  productName: brandedProductName,
  publish: brandedPublish,
  // 产物文件名：上游写死 "opencode-desktop-${os}-${arch}.${ext}"（brand 层不改 submodule，
  // 故上游前缀原样带出）。这里覆盖为 brand.json 的 binName，保留上游的 ${os}-${arch}.${ext}
  // 结构（Linux 下 ${arch} 渲染为 x86_64）。latest*.yml 内引用的产物名同步随之更新。
  artifactName: brandedArtifactName,
  // 由 appId 派生的 Linux 桌面身份需同步覆盖，否则窗口类 / 启动器与新 appId 不一致。
  extraMetadata: {
    ...base.extraMetadata,
    desktopName: `${brandedAppId}.desktop`,
  },
  mac: {
    ...base.mac,
    icon: path.join(iconsDir, "icon.icns"),
    // dmg = 人工下载安装；zip = electron-updater 自更新载体（macOS 只能用 zip 更新、不能用 dmg，
    // 且只出 dmg 时不会生成可用于更新的 latest-mac.yml）。故两者都出。
    // 架构不在此写死：@lydell/node-pty 按平台拆成独立子包，靠 optionalDependencies
    // 只装「当前 runner 架构」那一个。若在单台 arm64 runner 上跨架构出 x64 包，
    // 打进去的仍是 arm64 的 pty.node，运行时找 darwin-x64/pty.node 会崩。
    // 故 CI 用两个原生 runner（Intel + Apple Silicon）各自 --x64 / --arm64 出包，
    // 这里只保留 target，架构由命令行 --x64 / --arm64 指定，各出各的独立 dmg + zip。
    target: ["dmg", "zip"],
    // 无凭据降级：关公证 + ad-hoc 签名（identity:"-"，非 null）+ 关 hardenedRuntime。
    // identity:"-" 让包带上 ad-hoc 签名，Squirrel.Mac 自更新前的 SecCodeCopySelf 才读得到
    // 签名（identity:null 会让自更新报 "Could not get code signature" 并死循环）。详见上方注释。
    ...(unsigned ? { notarize: false, hardenedRuntime: false, identity: "-" } : {}),
  },
  dmg: {
    ...base.dmg,
    // 上游 dmg.sign=true；无凭据时关掉，否则 dmg 签名步骤失败。
    ...(unsigned ? { sign: false } : {}),
  },
  win: {
    ...base.win,
    icon: path.join(iconsDir, "icon.ico"),
    // 上游 win.signtoolOptions.sign 是自定义回调，内部调 Azure Trusted Signing。
    // 无 Azure 凭据时移除，产出未签名 .exe（验收只要求出包，不要求签名）。
    ...(unsigned ? { signtoolOptions: undefined } : {}),
  },
  nsis: {
    ...base.nsis,
    installerIcon: path.join(iconsDir, "icon.ico"),
    installerHeaderIcon: path.join(iconsDir, "icon.ico"),
  },
  linux: {
    ...base.linux,
    // Linux 传目录，electron-builder 从中挑选各尺寸 png。
    icon: iconsDir,
    // 验收标准要求产物是 .AppImage；上游 linux target 还含 deb / rpm
    // （rpm 需 runner 装 rpmbuild 工具）。只保留 AppImage，聚焦验收产物、
    // 避免额外系统依赖。
    target: ["AppImage"],
    executableName: brandedAppId,
    desktop: {
      ...base.linux?.desktop,
      entry: {
        ...base.linux?.desktop?.entry,
        StartupWMClass: brandedAppId,
      },
    },
  },
}

export default config
