# brand/icons — 品牌图标

本目录承载替换上游 opencode 的品牌图标资源（应用图标、安装器图标等），
与上游源码物理隔离。打包脚本从这里取图标覆盖 `opencode/packages/desktop/icons/`
等上游位置。

## 预期文件

| 文件 | 用途 | 平台 |
|---|---|---|
| `icon.icns` | 应用图标 | macOS |
| `icon.ico` | 应用图标 | Windows |
| `icon.png` | 应用图标（1024×1024 源图） | 通用 / Linux |

> 当前为 **Dokng 品牌图标**：蓝色（`#3b6ef5` → `#5570f0` 渐变）圆角方块 + 白色字母 D，
> 主色取自账户面板参考设计。三种格式均由 `generate-icon.mjs` 从同一 SVG 渲染，
> 可被 electron-builder 直接消费。图标为二进制资源，不含任何密钥，可安全提交进 git。
>
> - `icon.png`：1024×1024 源图（通用 / Linux，electron-builder 从中挑各尺寸）。
> - `icon.ico`：Windows 多尺寸（16/32/48/64/128/256，PNG 压缩编码）。
> - `icon.icns`：macOS 多尺寸（含 Retina @2x 的 icp4…ic14 chunk，PNG 编码）。
>
> `brand/electron-builder.brand.ts` 用 `import.meta.url` 计算本目录的**绝对路径**再
> 覆盖 `mac.icon` / `win.icon` / `nsis.installerIcon` / `linux.icon`，因此不受打包
> 时工作目录影响。

## 重新生成图标

图标由 `generate-icon.mjs` 生成（用 opencode 已装的 `sharp` 渲染 SVG → PNG，
再手工编码 ICO / ICNS，二者均用嵌入式 PNG 格式，无需额外的 ico/icns 依赖）：

```sh
cd opencode && node ../brand/icons/generate-icon.mjs
```

改主色 / 字母 / 圆角时改脚本顶部常量即可；产物文件名保持 `icon.{png,ico,icns}` 不变。
