# Dokng 下载落地页（Cloudflare Pages）

一个纯静态单页，运行时 `fetch` R2 上的 `latest*.yml`，解析出各平台最新版本与文件名，
渲染三平台下载按钮。无后端、无构建步骤。

## 工作原理

- 页面里的 `DL_BASE` 常量指向 R2 自定义域的 `open-code/` 目录（发布产物所在）。
- 页面加载时并发拉取 `latest-mac.yml` / `latest.yml`（Windows）/ `latest-linux.yml`，
  解析出 `version` 与各文件的相对文件名，拼成 `DL_BASE/<文件名>` 下载链接。
- macOS 展示 `.dmg`（Apple Silicon / Intel 分开），Windows 展示 `.exe`，Linux 展示 `.AppImage`。
  `.zip`（macOS 自更新载体）不在下载页展示。

## 部署前必须替换占位

1. **`index.html` 里的 `DL_BASE`**：已设为 `https://dl.dokng.com/open-code`，
   必须与 `brand/brand.json` 的 `updateBaseUrl` 完全一致。这是唯一的分发源 —— 本仓不发
   GitHub Release，`footer` 里原先的 Releases 链接已移除，无需再维护仓库名。

## Cloudflare Pages 部署步骤

1. Cloudflare Dashboard → Workers & Pages → Create → Pages → Connect to Git。
2. 选本仓库，配置：
   - **Production branch**：`main`
   - **Build command**：留空（纯静态）
   - **Build output directory**：`open-code/brand/download-page`
     （[monorepo] 合仓后目录下移了一层，已有 Pages 项目须到 Settings → Builds &
     deployments 把输出目录从 `brand/download-page` 改过来，否则部署出空站点）
3. 部署后绑定自定义子域（如 `download.<域名>`）：Pages 项目 → Custom domains → 添加。
4. 每次 `push` 到 `main` 自动重新部署。

## CORS 配置（关键）

下载页所在域（Pages 子域，如 `download.<域名>`）与 `DL_BASE` 子域（如 `dl.<域名>`）**不同源**，
浏览器 `fetch` R2 上的 `latest*.yml` 会被 CORS 拦截。需在 R2 桶加一条 CORS 规则允许下载页域 `GET`。

R2 Dashboard → 选桶 → Settings → CORS Policy，添加：

```json
[
  {
    "AllowedOrigins": ["https://download.<域名>"],
    "AllowedMethods": ["GET"],
    "AllowedHeaders": ["*"],
    "MaxAgeSeconds": 3600
  }
]
```

> 把 `https://download.<域名>` 换成下载页真实域名。安装包本身是 `<a download>` 直接跳转下载，
> 不受 CORS 限制；只有 JS `fetch` 的 yml 需要这条规则。

## 本地预览

```sh
cd brand/download-page
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000
```

本地预览时若 `DL_BASE` 指向的 R2 还没数据，页面会显示「暂时无法获取下载信息」——属正常，
待真实发布后 R2 有 `latest*.yml` 即可正常解析。
