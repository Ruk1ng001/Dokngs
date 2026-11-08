#!/usr/bin/env python3
"""Populate Tauri's tool cache through official release APIs before compiling."""

import argparse
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import platform
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.parse import quote, unquote, urlsplit
import zipfile


def github(endpoint, *, binary=False):
    command = ["gh", "api", endpoint]
    if binary:
        command += ["-H", "Accept: application/octet-stream"]
    for attempt in range(3):
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        if result.returncode == 0:
            return result.stdout if binary else json.loads(result.stdout)
        if attempt == 2:
            raise RuntimeError(result.stderr.decode(errors="replace"))
        print(f"GitHub API request failed; retrying in {(attempt + 1) * 5}s", flush=True)
        time.sleep((attempt + 1) * 5)


def source(version, relative):
    endpoint = (
        "repos/tauri-apps/tauri/contents/crates/tauri-bundler/src/bundle/"
        f"{relative}?ref=tauri-cli-v{version}"
    )
    return base64.b64decode(github(endpoint)["content"]).decode()


def matched(pattern, text):
    match = re.search(pattern, text)
    if not match:
        raise RuntimeError(f"Tauri tool layout changed; cannot find {pattern!r}")
    return match.group(1)


def constant(text, name):
    return matched(rf'const {name}: &str\s*=\s*"([^"]+)";', text)


def release_file(url, expected=None):
    parsed = urlsplit(url)
    match = re.fullmatch(r"/([^/]+/[^/]+)/releases/download/([^/]+)/([^/]+)", parsed.path)
    if parsed.scheme != "https" or parsed.netloc != "github.com" or not match:
        raise RuntimeError(f"Expected an official GitHub release URL: {url}")
    repo, tag, filename = map(unquote, match.groups())
    release = github(f"repos/{repo}/releases/tags/{quote(tag, safe='')}")
    asset = next((item for item in release["assets"] if item["name"] == filename), None)
    if not asset:
        raise RuntimeError(f"Release asset is missing: {repo} {tag} {filename}")
    digest = asset.get("digest")
    if not expected and (not digest or not re.fullmatch(r"sha256:[a-fA-F0-9]{64}", digest)):
        raise RuntimeError(f"Official SHA256 digest is missing for {filename}")
    data = github(f"repos/{repo}/releases/assets/{asset['id']}", binary=True)
    if len(data) != asset["size"]:
        raise RuntimeError(f"Release asset size mismatch: {filename}")
    hashes = [expected] if expected else []
    if digest and re.fullmatch(r"sha256:[a-fA-F0-9]{64}", digest):
        hashes.append(tuple(digest.split(":", 1)))
    for algorithm, value in hashes:
        if hashlib.new(algorithm, data).hexdigest() != value.lower():
            raise RuntimeError(f"{algorithm} mismatch: {filename}")
    print(f"Verified official release asset: {repo} {tag} {filename}", flush=True)
    return data


def save_executable(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".download")
    temporary.write_bytes(data)
    temporary.chmod(0o755)
    temporary.replace(path)


def extract_zip(data, destination, prefix=""):
    # Extract only after authenticating the complete archive. Use a temporary
    # directory so an interrupted download cannot leave a half-valid toolset.
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="tauri-tools-", dir=destination.parent) as temp:
        root = Path(temp)
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for item in archive.infolist():
                name = item.filename.replace("\\", "/")
                target = (root / name).resolve()
                if not target.is_relative_to(root.resolve()):
                    raise RuntimeError(f"Unsafe archive member: {item.filename}")
            archive.extractall(root)
        extracted = root / prefix if prefix else root
        if not extracted.is_dir():
            raise RuntimeError(f"Tauri archive layout changed: {prefix}")
        shutil.copytree(extracted, destination, dirs_exist_ok=True)


def prepare_linux(version, cache, arch):
    text = source(version, "linux/appimage/linuxdeploy.rs")
    commit = constant(text, "LINUXDEPLOY_COMMIT_HASH")
    variables = {"arch": arch, "linuxdeploy_arch": "i386" if arch == "i686" else arch,
                 "LINUXDEPLOY_COMMIT_HASH": commit}
    urls = re.findall(r'"(https://github\.com/[^"\n]+)"', text)
    for variable in ("apprun", "linuxdeploy", "appimage"):
        # Both the cache filename and download URL come from this installed
        # CLI's release source, so upstream tool revisions do not stay pinned here.
        name = matched(rf'let {variable} = tools_path\.join\((?:format!\(\s*)?"([^"]+)"', text)
        prefix = {"apprun": "AppRun-", "linuxdeploy": "linuxdeploy-{linuxdeploy_arch}",
                  "appimage": "linuxdeploy-plugin-appimage-"}[variable]
        url = next((item for item in urls if item.rsplit("/", 1)[-1].startswith(prefix)), None)
        if not url:
            raise RuntimeError(f"Tauri tool URL is missing for {variable}")
        save_executable(cache / name.format(**variables), release_file(url.format(**variables)))


def prepare_windows(version, cache):
    wix = source(version, "windows/msi/mod.rs")
    wix_name = matched(r'let wix_path = tauri_tools_path\.join\("([^"]+)"\)', wix)
    extract_zip(release_file(constant(wix, "WIX_URL"), ("sha256", constant(wix, "WIX_SHA256"))),
                cache / wix_name)
    nsis = source(version, "windows/nsis/mod.rs")
    nsis_name = matched(r'let nsis_toolset_path = tauri_tools_path\.join\("([^"]+)"\)', nsis)
    nsis_prefix = matched(r'fs::rename\(_tauri_tools_path\.join\("([^"]+)"\)', nsis)
    extract_zip(release_file(constant(nsis, "NSIS_URL"), ("sha1", constant(nsis, "NSIS_SHA1"))),
                cache / nsis_name, nsis_prefix)
    plugin = cache / nsis_name / "Plugins/x86-unicode/additional/nsis_tauri_utils.dll"
    save_executable(plugin, release_file(constant(nsis, "NSIS_TAURI_UTILS_URL"),
                                        ("sha1", constant(nsis, "NSIS_TAURI_UTILS_SHA1"))))
    executable = cache / nsis_name / "NSIS.exe"
    if hashlib.sha1(executable.read_bytes()).hexdigest() != constant(nsis, "NSIS_EXE_SHA1").lower():
        raise RuntimeError("Extracted NSIS.exe does not match the upstream checksum")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cli-version", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"\d+\.\d+\.\d+", args.cli_version):
        raise RuntimeError("Expected an installed stable Tauri CLI version")
    if sys.platform == "win32":
        cache = Path(os.environ["LOCALAPPDATA"]) / "tauri"
        prepare_windows(args.cli_version, cache)
    elif sys.platform == "linux":
        cache = Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache"))) / "tauri"
        prepare_linux(args.cli_version, cache, platform.machine())
    else:
        print("No external Tauri tool downloads are needed on this platform")
        return
    print(f"Tauri {args.cli_version} tool cache ready: {cache}")


if __name__ == "__main__":
    main()
