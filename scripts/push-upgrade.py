#!/usr/bin/env python3
"""Publish an already validated upgrade commit and its release tag atomically.

Only changes to another product may be rebased into the validated commit. A
rejected tag therefore never leaves main advanced without a release trigger.
"""

import argparse
import os
import re
import subprocess
import sys
import time
from pathlib import Path


PRODUCTS = {"cc-switch": "ccs", "open-code": "dokng"}
WORKFLOWS = {
    "cc-switch": {"cc-switch-upgrade.yml", "cc-switch-release.yml"},
    "open-code": {"open-code-release.yml"},
    "official": {"official-mirror.yml"},
}


def git(*args, check=True):
    return subprocess.run(["git", *args], check=check, text=True, capture_output=True)


def other_product_path(path, product):
    for other, workflows in WORKFLOWS.items():
        if other != product and (
            path.startswith(other + "/")
            or path in {".github/workflows/" + name for name in workflows}
        ):
            return True
    return False


def next_tag(product):
    base = Path(product, "brand", "BASE_TAG").read_text().strip()
    if not re.fullmatch(r"v\d+\.\d+\.\d+", base):
        raise RuntimeError(f"Invalid {product} base tag: {base!r}")
    prefix = f"{base}-{PRODUCTS[product]}."
    tags = git("tag", "--list", prefix + "*").stdout.splitlines()
    numbers = [int(tag[len(prefix):]) for tag in tags if tag[len(prefix):].isdigit()]
    return prefix + str(max(numbers, default=0) + 1)


def fetch_main():
    git("fetch", "--quiet", "origin", "refs/heads/main:refs/remotes/origin/main")


def published(tag, commit):
    # A lost push response is not a failed transaction. Query both references
    # before retrying so we do not create a second release for the same commit.
    result = git("ls-remote", "--refs", "origin", "refs/heads/main", f"refs/tags/{tag}", check=False)
    if result.returncode:
        return False
    refs = {line.split()[1]: line.split()[0] for line in result.stdout.splitlines()}
    if refs.get(f"refs/tags/{tag}") != commit:
        return False
    if refs.get("refs/heads/main") == commit:
        return True
    fetch_main()
    return git("merge-base", "--is-ancestor", commit, "origin/main", check=False).returncode == 0


def push_upgrade(product, attempts=3, delay=5):
    root = git("rev-parse", "--show-toplevel").stdout.strip()
    os.chdir(root)
    if git("status", "--porcelain", "--untracked-files=no").stdout.strip():
        raise RuntimeError("Upgrade commit must have a clean tracked worktree")
    validated_base = git("rev-parse", "HEAD^").stdout.strip()
    for attempt in range(1, attempts + 1):
        tag = None
        commit = None
        completed = False
        try:
            fetch_main()
            git("fetch", "--quiet", "--tags", "origin")
            remote = git("rev-parse", "origin/main").stdout.strip()
            if remote != validated_base:
                if git("merge-base", "--is-ancestor", validated_base, remote, check=False).returncode:
                    raise RuntimeError("Remote main was rewritten; validate the upgrade again")
                changed = git("diff", "--name-only", "-z", validated_base, remote).stdout.split("\0")
                unsafe = [path for path in changed if path and not other_product_path(path, product)]
                if unsafe:
                    raise RuntimeError("Remote main changed validated inputs; rerun validation: " + ", ".join(unsafe))
                rebased = git("rebase", "origin/main", check=False)
                if rebased.returncode:
                    git("rebase", "--abort", check=False)
                    raise RuntimeError("Could not rebase changes from another product")
            tag = next_tag(product)
            commit = git("rev-parse", "HEAD").stdout.strip()
            git("tag", tag, commit)
            result = git("push", "--atomic", "origin", "HEAD:refs/heads/main", f"refs/tags/{tag}:refs/tags/{tag}", check=False)
            if result.returncode == 0 or published(tag, commit):
                completed = True
                print(f"Published main and {tag} atomically ({commit})")
                return tag
            print(f"Atomic push attempt {attempt}/{attempts} rejected; main and tag were not partially published", file=sys.stderr)
        except subprocess.CalledProcessError as error:
            print(f"Git {error.cmd[1]} failed on attempt {attempt}/{attempts}", file=sys.stderr)
        finally:
            # Remove only the local candidate created by this attempt. Never
            # rewrite or delete an existing remote tag.
            if tag and commit and not completed:
                current = git("rev-parse", "--verify", f"refs/tags/{tag}", check=False)
                if current.returncode == 0 and current.stdout.strip() == commit:
                    git("tag", "--delete", tag)
        if attempt < attempts:
            time.sleep(delay * attempt)
    raise RuntimeError("Atomic publication failed; rerun the upgrade after resolving the push failure")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("product", choices=PRODUCTS)
    parser.add_argument("--attempts", type=int, default=3)
    parser.add_argument("--retry-delay", type=float, default=5)
    args = parser.parse_args()
    if args.attempts < 1 or args.retry_delay < 0:
        parser.error("attempts must be positive and retry delay nonnegative")
    try:
        push_upgrade(args.product, args.attempts, args.retry_delay)
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(f"::error::{error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
