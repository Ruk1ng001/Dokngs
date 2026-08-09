#!/usr/bin/env python3
"""[ccs] 校验 brand/patches.manifest 与补丁/叠加层的一致性（preflight 机器门禁）。

manifest 格式（每补丁一个 section，# 开头为注释）：
  [NN-patch-name]                 # 对应 brand/patches/NN-patch-name.patch
  depends = NN-other, NN-another  # 可选：语义/文本前置依赖（逗号或空白分隔）
  file = path/relative/to/upstream
  file = ...                      # 该补丁 diff 覆盖的全部文件，逐行声明

校验项：
  1. section 集合 == 磁盘 *.patch 集合（双向，不允许缺失或多余）；
  2. 每补丁：declared files == `git apply --numstat` 实际 diff 文件集（双向）；
  3. depends：被依赖 section 必须存在，且其 NN 序号严格小于本补丁（NN 字典序即应用序，
     依赖必须先应用）；
  4. 补丁不得触碰保留路径（由 overlay / i18n 合并 / updater 注入接管的文件）；
  5. overlay 文件集与所有补丁 diff 文件集不相交（同一文件只能有一个供给来源）。

用法：
  check-manifest.py MANIFEST PATCHES_DIR [--overlay-dir DIR]
                    [--reserved PATH]... [--reserved-prefix PREFIX]...

退出码：0 全部一致；非 0 任一校验失败（stderr 列出明细）。
"""

from __future__ import annotations

import argparse
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

# Windows GitHub runner 控制台默认 cp1252，中文输出会 UnicodeEncodeError（历史坑：
# 版本注入脚本曾因此崩溃）。强制 UTF-8 + replace，任何平台都不因编码炸脚本。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

SECTION = re.compile(r"^\[([^\]\[]+)\]$")
KEYVAL = re.compile(r"^(depends|file)\s*=\s*(.*)$")


def fail(errors: list[str]) -> None:
    for line in errors:
        print(f"check-manifest: {line}", file=sys.stderr)
    raise SystemExit(1)


def parse_manifest(path: Path) -> dict[str, dict[str, list[str]]]:
    sections: dict[str, dict[str, list[str]]] = {}
    current: str | None = None
    for lineno, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        m = SECTION.match(line)
        if m:
            current = m.group(1)
            if current in sections:
                fail([f"{path}:{lineno}: 重复 section [{current}]"])
            sections[current] = {"depends": [], "file": []}
            continue
        m = KEYVAL.match(line)
        if not m:
            fail([f"{path}:{lineno}: 无法解析的行：{raw!r}"])
        if current is None:
            fail([f"{path}:{lineno}: 键值出现在任何 section 之前"])
        key, value = m.group(1), m.group(2).strip()
        if key == "depends":
            sections[current]["depends"] += [
                d for d in re.split(r"[,\s]+", value) if d
            ]
        else:
            if not value:
                fail([f"{path}:{lineno}: file = 后为空"])
            sections[current]["file"].append(value)
    return sections


def numstat_files(patch: Path) -> set[str]:
    # 必须在「任何 git work tree 之外」跑（monorepo 实战坑）：`git apply` 在仓库内会把补丁
    # 路径按 work tree **顶层**解析，落在当前子目录之外的路径被静默忽略（git-apply(1)：
    # patched paths outside the current directory are ignored）——本仓从 cc-switch/ 调用，
    # 补丁里的 src-tauri/... 会被解析成 <repo根>/src-tauri/...，于是 numstat 输出空集，
    # 校验 2 反过来报「声明了 diff 中不存在的文件」。旧仓 cwd 恰好是仓库根才没暴露。
    # 本校验只需要补丁的**文本**文件集（不碰工作区），所以放到临时空目录里做纯解析：
    #   - cwd=空临时目录 + GIT_CEILING_DIRECTORIES 阻断向上发现仓库；
    #   - 剔除 GIT_DIR/GIT_WORK_TREE，避免 CI 环境变量把 git 拉回某个仓库；
    #   - patch 传绝对路径，因为 cwd 已被换掉。
    # 换 cwd 而非改用 `git -C <submodule>`：后者要求 submodule 已物化，而 preflight 的语义
    # 是「不依赖上游工作区的静态门禁」（CI 里先 preflight 再 init submodule）。
    env = {k: v for k, v in os.environ.items() if k not in ("GIT_DIR", "GIT_WORK_TREE")}
    with tempfile.TemporaryDirectory() as neutral:
        env["GIT_CEILING_DIRECTORIES"] = str(Path(neutral).parent)
        proc = subprocess.run(
            ["git", "apply", "--numstat", str(patch.resolve())],
            capture_output=True,
            text=True,
            cwd=neutral,
            env=env,
        )
    if proc.returncode != 0:
        fail([f"{patch.name}: git apply --numstat 失败：{proc.stderr.strip()}"])
    files: set[str] = set()
    for line in proc.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) >= 3 and parts[2]:
            files.add(parts[2])
    return files


def nn_prefix(name: str) -> int:
    m = re.match(r"^(\d+)-", name)
    if not m:
        fail([f"补丁名 {name!r} 缺少 NN- 序号前缀（应用顺序依赖字典序）"])
    return int(m.group(1))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", type=Path)
    parser.add_argument("patches_dir", type=Path)
    parser.add_argument("--overlay-dir", type=Path)
    parser.add_argument("--reserved", action="append", default=[])
    parser.add_argument("--reserved-prefix", action="append", default=[])
    args = parser.parse_args()

    errors: list[str] = []
    sections = parse_manifest(args.manifest)
    patches = {
        p.name[: -len(".patch")]: p
        for p in sorted(args.patches_dir.glob("*.patch"))
    }

    # 1. section 集合 == patch 集合
    for name in sorted(set(patches) - set(sections)):
        errors.append(f"manifest 缺少 section [{name}]（磁盘存在 {name}.patch）")
    for name in sorted(set(sections) - set(patches)):
        errors.append(f"manifest 声明了不存在的补丁 [{name}]")
    if errors:
        fail(errors)

    # 2. 每补丁 declared files == numstat 实际文件集；4. 保留路径
    for name, patch in patches.items():
        declared = set(sections[name]["file"])
        actual = numstat_files(patch)
        for f in sorted(actual - declared):
            errors.append(f"[{name}] diff 覆盖了未声明文件：{f}")
        for f in sorted(declared - actual):
            errors.append(f"[{name}] 声明了 diff 中不存在的文件：{f}")
        for f in sorted(actual):
            if f in args.reserved or any(
                f.startswith(p) for p in args.reserved_prefix
            ):
                errors.append(
                    f"[{name}] 触碰保留路径 {f}（该文件由 overlay/i18n/updater 注入接管，"
                    "不得再用补丁改动）"
                )

    # 3. depends 存在性 + NN 序一致
    for name, body in sections.items():
        own = nn_prefix(name)
        for dep in body["depends"]:
            if dep not in sections:
                errors.append(f"[{name}] depends 指向不存在的 section：{dep}")
                continue
            if nn_prefix(dep) >= own:
                errors.append(
                    f"[{name}] depends={dep} 的序号不小于自身——依赖必须先应用，"
                    "请调整 NN 前缀或依赖声明"
                )

    # 5. overlay 与补丁文件集不相交
    if args.overlay_dir and args.overlay_dir.is_dir():
        overlay_files = {
            str(p.relative_to(args.overlay_dir))
            for p in args.overlay_dir.rglob("*")
            if p.is_file()
        }
        for name, patch in patches.items():
            clash = overlay_files & numstat_files(patch)
            for f in sorted(clash):
                errors.append(f"[{name}] 与 overlay 冲突：{f} 同时出现在补丁 diff 与 brand/overlay/")

    if errors:
        fail(errors)
    total_files = sum(len(b["file"]) for b in sections.values())
    print(
        f"check-manifest: {len(sections)} 个 section 与补丁集一致，"
        f"{total_files} 个声明文件与 numstat 全部匹配，依赖序合法。"
    )


if __name__ == "__main__":
    main()
