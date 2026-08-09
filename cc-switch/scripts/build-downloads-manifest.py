#!/usr/bin/env python3
"""生成 latest-downloads.json：new-api 首页下载区用的产物清单。

为什么需要它（与 latest.json 的分工）：
  latest.json 是 Tauri updater 的元数据，只收录带 .sig 的 updater 载体——macOS 那条
  是 .tar.gz（解开是 .app），并非给人下载的格式；.dmg 因为没有 .sig 根本进不了
  latest.json。new-api 首页直接读 latest.json 时，macOS 按钮就会下发 .tar.gz，而
  .dmg 明明躺在同一个版本子目录里却无从发现。故另出一份纯展示用清单。

约定：
  - 只收三个平台的主推安装包，字段形状对齐 new-api controller 的 clientProduct /
    clientAsset，后端解析即用。
  - .dmg 是可选产物（收集步骤里缺失不阻断），不存在即不收录，首页对应按钮自动隐藏。
  - url 为绝对地址，前缀 <base>/<rel_version>/，与 latest.json 同构。
  - platform 用 "mac" 而非 mac-arm64 / mac-x64：cc-switch 的 macOS 是 universal 包，
    单文件覆盖两架构，分列两个按钮会指向同一个文件。

用法：build-downloads-manifest.py <assets-dir> <tag> <base-url> <out-json>
"""

import json
import os
import sys

# (文件名模板, platform, label)：顺序即前端展示顺序。
SPECS = [
    ("CC-Switch-{tag}-Windows.msi", "windows", "Windows"),
    ("CC-Switch-{tag}-macOS.dmg", "mac", "macOS"),
    ("CC-Switch-{tag}-Linux-x86_64.AppImage", "linux", "Linux"),
]


def main() -> int:
    if len(sys.argv) != 5:
        print(__doc__, file=sys.stderr)
        return 2
    assets_dir, tag, base_url, out_json = sys.argv[1:5]

    # 版本子目录名 = 去 v 前缀的 tag，与 latest.json 里 url 的前缀、R2 清理抽取的
    # token 三者保持一致。
    rel_version = tag[1:] if tag.startswith("v") else tag
    base_url = base_url.rstrip("/")

    assets = []
    for template, platform, label in SPECS:
        filename = template.format(tag=tag)
        path = os.path.join(assets_dir, filename)
        if not os.path.isfile(path) or os.path.getsize(path) <= 0:
            print(f"  跳过（未产出）：{filename}")
            continue
        assets.append(
            {
                "platform": platform,
                "label": label,
                "filename": filename,
                "url": f"{base_url}/{rel_version}/{filename}",
                "size": os.path.getsize(path),
            }
        )
        print(f"  收录：{filename}")

    if not assets:
        print("::error::latest-downloads.json 收录不到任何产物", file=sys.stderr)
        return 1

    with open(out_json, "w", encoding="utf-8") as fh:
        json.dump({"version": rel_version, "assets": assets}, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"✅ 已生成 {out_json}（{len(assets)} 个产物）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
