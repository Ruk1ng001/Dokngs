#!/usr/bin/env python3
"""Refuse to replace R2 update metadata with an older release.

Call inside the product's publication concurrency lock, before any R2 writes.
Only a missing object is treated as an initial publication; access/network or
malformed metadata errors stop publication instead of bypassing the guard.
"""

import argparse
import json
import re
import subprocess
import sys
import tempfile
from pathlib import Path


METADATA = {
    "cc-switch": ("latest.json", "latest-downloads.json"),
    "open-code": ("latest.yml", "latest-mac.yml", "latest-linux.yml", "latest-linux-arm64.yml"),
}
SUFFIX = {"cc-switch": "ccs", "open-code": "dokng"}


def version_tuple(product, version, updater=False):
    suffix = "" if updater and product == "cc-switch" else re.escape(SUFFIX[product]) + r"\."
    match = re.fullmatch(r"v?(\d+)\.(\d+)\.(\d+)-" + suffix + r"(\d+)", version)
    if not match:
        raise ValueError(f"Invalid {product} release version: {version!r}")
    return tuple(int(part) for part in match.groups())


def metadata_version(name, body):
    if name.endswith(".json"):
        version = json.loads(body)["version"]
        if not isinstance(version, str):
            raise ValueError(f"{name}: version must be a string")
        return version
    matches = re.findall(r"^version:\s*([^\r\n]+)$", body, re.MULTILINE)
    if len(matches) != 1:
        raise ValueError(f"{name}: expected one version field")
    return matches[0].strip().strip("\"'")


def check_versions(product, candidate, documents):
    target = version_tuple(product, candidate)
    for name, body in documents.items():
        current = metadata_version(name, body)
        existing = version_tuple(product, current, updater=name == "latest.json")
        if existing > target:
            raise ValueError(f"{name} already serves {current}; refusing older {candidate}")


def read_metadata(product, bucket, endpoint):
    documents = {}
    with tempfile.TemporaryDirectory(prefix="release-version-") as directory:
        for name in METADATA[product]:
            path = Path(directory, name)
            result = subprocess.run(
                ["aws", "s3api", "get-object", "--bucket", bucket, "--key", f"{product}/{name}",
                 "--endpoint-url", endpoint, str(path)], text=True, capture_output=True,
            )
            if result.returncode:
                if re.search(r"\((?:404|NoSuchKey|NotFound)\)", result.stderr):
                    continue
                raise RuntimeError(f"Cannot read {product}/{name}; publication stopped")
            documents[name] = path.read_text()
    return documents


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("product", choices=METADATA)
    parser.add_argument("version")
    parser.add_argument("--bucket", required=True)
    parser.add_argument("--endpoint", required=True)
    args = parser.parse_args()
    try:
        version_tuple(args.product, args.version)
        documents = read_metadata(args.product, args.bucket, args.endpoint)
        check_versions(args.product, args.version, documents)
    except (ValueError, KeyError, RuntimeError, OSError) as error:
        print(f"::error::{error}", file=sys.stderr)
        return 1
    print(f"Release version checked: {args.version} ({len(documents)} existing metadata files)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
