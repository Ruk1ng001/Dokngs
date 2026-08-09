#!/usr/bin/env python3
"""[ccs] 把 brand/updater.conf.json 的 pubkey/endpoints 注入 upstream tauri.conf.json。

替代原补丁 01（对 plugins.updater 两行的 .patch）：文本补丁写死了上游旧值作上下文，
上游一旦改动该区块即失配；本脚本从目标文件解析出当前值做定点替换，对上游漂移免疫。

注入方式：
  - 解析目标 JSON 取 plugins.updater 当前 pubkey / endpoints；
  - 已等于期望值 → 幂等 no-op；
  - pubkey：对「当前值的 JSON 字符串字面量」做精确文本替换（不整文件重排，其余字节保留）；
  - endpoints：整个数组按本仓库配置覆盖（不逐元素对位替换）。理由见
    replace_endpoints_array——上游会增删自己的镜像（v3.19.0 新增 dl.ccswitch.io），个数不等时
    对位替换无解；且残留任何上游 endpoint 都会让客户端可能拉到由上游私钥签名的包，与注入的
    pubkey 不配对。故本仓库配置是分发源的唯一真源。
  - 两者替换后均回读解析，校验 plugins.updater == 期望值。

用法：
  inject-updater.py --conf brand/updater.conf.json --target upstream/src-tauri/tauri.conf.json
  inject-updater.py --conf brand/updater.conf.json --check-only   # 仅校验配置合法

退出码：0 成功（含 no-op）；非 0 配置/目标非法、替换歧义（值出现多次）或校验失败。
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


def fail(message: str) -> None:
    print(f"inject-updater: {message}", file=sys.stderr)
    raise SystemExit(1)


def load_conf(path: Path) -> tuple[str, list[str]]:
    if not path.is_file():
        fail(f"缺少注入配置：{path}")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        fail(f"{path} 不是合法 JSON：{e}")
    pubkey = data.get("pubkey")
    endpoints = data.get("endpoints")
    if not isinstance(pubkey, str) or not pubkey:
        fail(f"{path} 缺少非空字符串字段 pubkey")
    if (
        not isinstance(endpoints, list)
        or not endpoints
        or not all(isinstance(e, str) and e for e in endpoints)
    ):
        fail(f"{path} 的 endpoints 必须是非空字符串数组")
    return pubkey, endpoints


def replace_literal(text: str, old_value: str, new_value: str, what: str) -> str:
    old_lit = json.dumps(old_value, ensure_ascii=False)
    new_lit = json.dumps(new_value, ensure_ascii=False)
    count = text.count(old_lit)
    if count == 0:
        fail(f"目标文件中找不到 {what} 的当前值字面量（格式异常，需人工处理）")
    if count > 1:
        fail(f"{what} 的当前值字面量在目标文件出现 {count} 次，替换有歧义，需人工处理")
    return text.replace(old_lit, new_lit)


def replace_endpoints_array(text: str, endpoints: list[str]) -> str:
    """整体替换 plugins.updater.endpoints 数组（而非逐元素对位替换）。

    为什么是整体覆盖而不是对位替换：endpoints 是「我们的分发源清单」，语义上必须完全取代
    上游的清单，不是逐条改写——上游增删自己的镜像时元素个数会变（v3.19.0 就新增了
    dl.ccswitch.io），对位替换在个数不等时无解。更要紧的是安全方向：残留任何上游 endpoint
    都意味着客户端可能从上游拉取更新包，而那些包由上游私钥签名，与我们注入的 pubkey 不配对
    （轻则更新失败，重则把用户导向非本项目的产物）。故此处以本仓库配置为唯一真源。

    仍保持保守：只在全文恰好出现一次 "endpoints" 键时动手，否则报错要求人工处理；替换后由
    调用方回读校验解析结果 == 期望值。
    """
    key_lit = '"endpoints"'
    count = text.count(key_lit)
    if count == 0:
        fail("目标文件中找不到 endpoints 键（上游结构变化，需人工处理）")
    if count > 1:
        fail(f"endpoints 键在目标文件出现 {count} 次，定位有歧义，需人工处理")

    key_at = text.index(key_lit)
    open_at = text.find("[", key_at)
    if open_at == -1:
        fail("endpoints 的值不是数组（上游结构变化，需人工处理）")
    # 扫括号配平找数组结尾；endpoints 元素是 URL 字符串，不含嵌套数组，但仍按通用方式处理。
    depth = 0
    close_at = -1
    for i in range(open_at, len(text)):
        if text[i] == "[":
            depth += 1
        elif text[i] == "]":
            depth -= 1
            if depth == 0:
                close_at = i
                break
    if close_at == -1:
        fail("endpoints 数组没有闭合（目标文件异常，需人工处理）")

    # 复用数组起始行的缩进，保持上游 tauri.conf.json 的排版风格。
    line_start = text.rfind("\n", 0, key_at) + 1
    indent = text[line_start:key_at]
    inner = f",\n{indent}  ".join(
        json.dumps(e, ensure_ascii=False) for e in endpoints
    )
    new_array = f"[\n{indent}  {inner}\n{indent}]"
    return text[:open_at] + new_array + text[close_at + 1 :]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--conf", required=True, type=Path)
    parser.add_argument("--target", type=Path)
    parser.add_argument("--check-only", action="store_true")
    args = parser.parse_args()

    pubkey, endpoints = load_conf(args.conf)
    if args.check_only:
        print("inject-updater: 注入配置 JSON 合法（pubkey + "
              f"{len(endpoints)} 个 endpoint）。")
        return

    if args.target is None:
        fail("非 --check-only 模式必须提供 --target")
    if not args.target.is_file():
        fail(f"找不到目标文件：{args.target}")

    text = args.target.read_text(encoding="utf-8")
    try:
        conf = json.loads(text)
    except json.JSONDecodeError as e:
        fail(f"{args.target} 不是合法 JSON：{e}")

    updater = conf.get("plugins", {}).get("updater")
    if not isinstance(updater, dict):
        fail(f"{args.target} 缺少 plugins.updater 区块（上游结构变化，需人工处理）")
    cur_pubkey = updater.get("pubkey")
    cur_endpoints = updater.get("endpoints")
    if not isinstance(cur_pubkey, str) or not isinstance(cur_endpoints, list):
        fail(f"{args.target} 的 plugins.updater 缺少 pubkey/endpoints 字段")

    if cur_pubkey == pubkey and cur_endpoints == endpoints:
        print("inject-updater: no-op（pubkey/endpoints 已是目标值）。")
        return

    if len(cur_endpoints) != len(endpoints):
        # 个数不等不再是错误：endpoints 走整体覆盖（见 replace_endpoints_array 的理由）。
        # 记一行日志便于在 CI 里看出上游改过自己的分发源清单。
        print(
            f"inject-updater: 上游 endpoints 个数为 {len(cur_endpoints)}、"
            f"本仓库配置为 {len(endpoints)}，按整体覆盖处理"
            f"（上游值：{', '.join(cur_endpoints)}）。"
        )

    if cur_pubkey != pubkey:
        text = replace_literal(text, cur_pubkey, pubkey, "pubkey")
    if cur_endpoints != endpoints:
        text = replace_endpoints_array(text, endpoints)

    try:
        check = json.loads(text)
    except json.JSONDecodeError as e:
        fail(f"替换后的 {args.target} 不是合法 JSON（bug）：{e}")
    got = check.get("plugins", {}).get("updater", {})
    if got.get("pubkey") != pubkey or got.get("endpoints") != endpoints:
        fail(f"替换后的 {args.target} 校验失败：plugins.updater 与期望不一致（bug）")

    args.target.write_text(text, encoding="utf-8")
    print(f"inject-updater: 已注入 pubkey + {len(endpoints)} 个 endpoint "
          f"→ {endpoints[0]}")


if __name__ == "__main__":
    main()
