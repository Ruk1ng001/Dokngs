#!/usr/bin/env python3
"""Exercise rebase recovery with real Git repositories, without touching the checkout."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SCRIPTS = Path(__file__).resolve().parent


class RebaseFixture:
    def __init__(self, shared=False):
        self.tmp = tempfile.TemporaryDirectory(prefix="dokng-rebase-test-")
        self.root = Path(self.tmp.name)
        self.upstream = self.root / "upstream"
        self.project = self.root / "project"
        self.upstream.mkdir()
        self.project.mkdir()
        for repo in (self.upstream, self.project):
            self.git(repo, "init", "-q")
            self.git(repo, "config", "user.name", "Rebase test")
            self.git(repo, "config", "user.email", "rebase-test@local")
        for name in ("a.txt", "b.txt", "shared.txt"):
            (self.upstream / name).write_text("original\n")
        self.commit(self.upstream, "base")
        base = self.git(self.upstream, "rev-parse", "HEAD").stdout.strip()
        self.git(self.upstream, "tag", "v1.0.0")

        brand = self.project / "brand"
        (brand / "patches").mkdir(parents=True)
        sections = []
        for number, filename in enumerate(("a.txt", "b.txt"), start=1):
            name = f"{number:02}-feature"
            (self.upstream / filename).write_text(f"brand-{number}\n")
            files = [filename]
            if shared:
                with (self.upstream / "shared.txt").open("a") as output:
                    output.write(f"shared-{number}\n")
                files.append("shared.txt")
            diff = self.git(self.upstream, "diff", "--binary").stdout
            (brand / "patches" / f"{name}.patch").write_text(diff)
            sections.append(f"[{name}]\n" + "\n".join(files))
            self.commit(self.upstream, f"patch {number}")
        self.git(self.upstream, "reset", "--hard", base)
        (self.upstream / "upstream.txt").write_text("new release\n")
        self.commit(self.upstream, "release")
        self.git(self.upstream, "tag", "v1.0.1")
        self.git(self.project, "-c", "protocol.file.allow=always", "submodule", "add", "-q",
                 str(self.upstream), "opencode")
        self.source = self.project / "opencode"
        self.git(self.source, "checkout", "-q", "v1.0.0")
        (brand / "BASE_TAG").write_text("v1.0.0\n")
        (brand / "BASE_SHA").write_text(base + "\n")
        (brand / "patches.manifest").write_text("\n\n".join(sections) + "\n")

        scripts = self.project / "scripts"
        scripts.mkdir()
        for name in ("rebase-patches.sh", "apply-patches.sh", "export-patch.sh", "validate-patch.py"):
            source = Path(os.environ.get("REBASE_SCRIPT", SCRIPTS / name)) if name == "rebase-patches.sh" else SCRIPTS / name
            shutil.copy2(source, scripts / name)
            (scripts / name).chmod(0o755)
        # Canvas's manifest permits a shared file; use its real replay checker for that fixture.
        if shared:
            checker = (SCRIPTS / "apply-canvas-patches.sh").read_text()
            checker = checker.replace("infinite-canvas", "opencode").replace("canvas-patches", "patches")
            checker = checker.replace("CANVAS_BASE_SHA", "BASE_SHA")
            (scripts / "apply-patches.sh").write_text(checker)
        (scripts / "apply-patches.sh").rename(scripts / "apply-patches-real.sh")
        (scripts / "apply-patches.sh").write_text(
            '#!/usr/bin/env bash\nset -euo pipefail\n'
            'script_dir="$(cd "$(dirname "$0")" && pwd)"\n'
            'if [ "${1:-}" = --check ] && [ -f "$script_dir/../fail-check" ]; then exit 1; fi\n'
            'exec "$script_dir/apply-patches-real.sh" "$@"\n'
        )
        (scripts / "apply-patches.sh").chmod(0o755)
        self.commit(self.project, "fixture")
        self.worktree = self.source / ".tmp-rebase"
        self.run("plan", "v1.0.1")

    @staticmethod
    def git(repo, *args):
        return subprocess.run(["git", "-C", str(repo), *args], text=True, capture_output=True, check=True)

    def commit(self, repo, message):
        self.git(repo, "add", "-A")
        self.git(repo, "commit", "-qm", message)

    def run(self, *args, success=True):
        result = subprocess.run([str(self.project / "scripts/rebase-patches.sh"), *args],
                                cwd=self.project, text=True, capture_output=True)
        if success and result.returncode != 0:
            raise AssertionError(result.stdout + result.stderr)
        return result

    def close(self):
        self.tmp.cleanup()

    def replayed(self, filename):
        self.run_checker()
        check = self.root / "checked"
        self.git(self.source, "worktree", "add", "--detach", str(check), "v1.0.1")
        for patch in sorted((self.project / "brand/patches").glob("*.patch")):
            self.git(check, "apply", str(patch))
        return (check / filename).read_text()

    def run_checker(self):
        result = subprocess.run([str(self.project / "scripts/apply-patches.sh"), "--check"],
                                text=True, capture_output=True)
        if result.returncode != 0:
            raise AssertionError(result.stdout + result.stderr)


class RebaseRecoveryTests(unittest.TestCase):
    def fixture(self, shared=False):
        fixture = RebaseFixture(shared)
        self.addCleanup(fixture.close)
        return fixture

    def test_final_correction_is_exported_even_when_original_patch_was_strict(self):
        fixture = self.fixture()
        (fixture.worktree / "a.txt").write_text("brand-1\nmanual fix\n")
        fixture.run("finish")
        self.assertEqual(fixture.replayed("a.txt"), "brand-1\nmanual fix\n")

    def test_failed_finish_can_be_fixed_and_retried_without_losing_the_fix(self):
        fixture = self.fixture()
        marker = fixture.project / "fail-check"
        marker.touch()
        self.assertNotEqual(fixture.run("finish", success=False).returncode, 0)
        self.assertEqual((fixture.project / "brand/BASE_TAG").read_text(), "v1.0.0\n")
        self.assertTrue(fixture.worktree.exists())
        (fixture.worktree / "a.txt").write_text("brand-1\nretry fix\n")
        marker.unlink()
        fixture.run("finish")
        self.assertEqual(fixture.replayed("a.txt"), "brand-1\nretry fix\n")

    def test_pending_conflict_cannot_be_finished_by_deleting_rejects(self):
        fixture = self.fixture()
        (fixture.project / ".rebase-state/conflict").write_text("01-feature\t1\n")
        self.assertNotEqual(fixture.run("finish", success=False).returncode, 0)
        self.assertTrue(fixture.worktree.exists())

    def test_unique_file_fix_does_not_absorb_later_patch_on_shared_file(self):
        fixture = self.fixture(shared=True)
        (fixture.worktree / "a.txt").write_text("brand-1\nmanual fix\n")
        fixture.run("finish")
        self.assertEqual(fixture.replayed("a.txt"), "brand-1\nmanual fix\n")
        self.assertEqual((fixture.root / "checked/shared.txt").read_text(), "original\nshared-1\nshared-2\n")

    def test_ambiguous_shared_file_fix_is_preserved_and_rejected(self):
        fixture = self.fixture(shared=True)
        file = fixture.worktree / "shared.txt"
        file.write_text(file.read_text() + "ambiguous fix\n")
        result = fixture.run("finish", success=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("没有唯一补丁归属", result.stderr)
        self.assertIn("ambiguous fix", file.read_text())
        self.assertEqual((fixture.project / "brand/BASE_TAG").read_text(), "v1.0.0\n")


if __name__ == "__main__":
    unittest.main()
