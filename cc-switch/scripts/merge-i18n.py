#!/usr/bin/env python3
"""[ccs] 把 brand/i18n/account.<locale>.json 合并进 upstream 各 locale 的顶层 account 命名空间。

替代原补丁 05（4 个 locale 文件顶部插行的 .patch）：文本补丁对上游 locale 的任何头部
变动（key 重排 / prettier 格式化）都会失配，本脚本按语义合并、天然免疫。

合并方式（与原补丁 05 的产物逐字节同构）：
  - 目标文件不存在 account 命名空间 → 在首行 "{" 之后按 2 空格缩进文本插入
    `"account": {...},` 块，文件其余部分逐字节保留（不做整文件 JSON 重排）；
  - 已存在且与期望完全一致 → 幂等 no-op；
  - 已存在但内容不同 → 报错退出（重放必须从干净基线开始；出现此情况说明工作区没重置，
    或上游自己引入了 account 命名空间，需要人工处理）。

用法：
  merge-i18n.py --brand-dir brand/i18n --locales-dir upstream/src/i18n/locales
  merge-i18n.py --brand-dir brand/i18n --check-only     # 仅校验 brand 侧 JSON 合法

退出码：0 成功（含幂等 no-op）；非 0 参数错误 / JSON 非法 / 命名空间冲突。
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

# Windows GitHub runner 控制台默认 cp1252，中文输出会 UnicodeEncodeError（历史坑：
# 版本注入脚本曾因此崩溃）。强制 UTF-8 + replace，任何平台都不因编码炸脚本。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

LOCALES = ["en", "ja", "zh", "zh-TW"]


def fail(message: str) -> None:
    print(f"merge-i18n: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_brand(brand_dir: Path, locale: str) -> dict:
    path = brand_dir / f"account.{locale}.json"
    if not path.is_file():
        fail(f"缺少品牌文案文件：{path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        fail(f"{path} 不是合法 JSON：{e}")
    if not isinstance(data, dict) or not data:
        fail(f"{path} 顶层必须是非空对象")
    for key, value in data.items():
        if not isinstance(value, str):
            fail(f"{path} 的 {key!r} 不是字符串（account 命名空间应为扁平文案表）")
    return data


def render_block(account: dict) -> str:
    # json.dumps(indent=2) 的对象体（去掉外层花括号），整体再缩进 2 空格，
    # 形成与原补丁 05 相同的 `  "account": { ... },` 块。
    inner = json.dumps(account, ensure_ascii=False, indent=2).splitlines()[1:-1]
    lines = ['  "account": {']
    lines += [f"  {line}" for line in inner]
    lines.append("  },")
    return "\n".join(lines)


def merge_locale(brand_dir: Path, locales_dir: Path, locale: str) -> str:
    desired = load_brand(brand_dir, locale)
    target = locales_dir / f"{locale}.json"
    if not target.is_file():
        fail(f"找不到上游 locale 文件：{target}")
    text = target.read_text(encoding="utf-8")
    try:
        data = json.loads(text)
    except json.JSONDecodeError as e:
        fail(f"{target} 不是合法 JSON：{e}")

    if "account" in data:
        if data["account"] == desired:
            return f"no-op   {locale}.json（account 命名空间已一致）"
        fail(
            f"{target} 已存在不同内容的 account 命名空间；"
            "重放必须从干净基线开始（git -C upstream checkout -f . && git -C upstream clean -fd）"
        )

    lines = text.splitlines(keepends=True)
    if not lines or lines[0].rstrip("\r\n") != "{":
        fail(f"{target} 首行不是 '{{'，无法定位插入点（上游格式变化，需人工调整）")

    merged = lines[0] + render_block(desired) + "\n" + "".join(lines[1:])
    try:
        check = json.loads(merged)
    except json.JSONDecodeError as e:
        fail(f"合并后的 {target} 不是合法 JSON（bug）：{e}")
    if check.get("account") != desired:
        fail(f"合并后的 {target} account 命名空间与期望不一致（bug）")
    target.write_text(merged, encoding="utf-8")
    return f"merged  {locale}.json（+account，{len(desired)} keys）"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--brand-dir", required=True, type=Path)
    parser.add_argument("--locales-dir", type=Path)
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()

    if args.check_only:
        for locale in LOCALES:
            load_brand(args.brand_dir, locale)
        print(f"merge-i18n: {len(LOCALES)} 个品牌文案文件 JSON 合法。")
        return

    if args.locales_dir is None:
        fail("非 --check-only 模式必须提供 --locales-dir")
    for locale in LOCALES:
        print(f"merge-i18n: {merge_locale(args.brand_dir, args.locales_dir, locale)}")


if __name__ == "__main__":
    main()
