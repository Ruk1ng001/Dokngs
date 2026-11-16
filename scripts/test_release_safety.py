"""Release invariants exercised against local bare repositories and R2 stubs."""

import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


HERE = Path(__file__).resolve().parent


def module(name):
    spec = importlib.util.spec_from_file_location(name, HERE / f"{name}.py")
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


guard = module("check-release-version")
upgrade = module("push-upgrade")


class AtomicUpgradeTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="release-safety-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.remote = self.root / "remote.git"
        self.work = self.root / "work"
        self.run_git(self.root, "init", "--bare", "--initial-branch=main", str(self.remote))
        self.run_git(self.root, "clone", str(self.remote), str(self.work))
        self.configure(self.work)
        for product in ("cc-switch", "open-code"):
            base = self.work / product / "brand" / "BASE_TAG"
            base.parent.mkdir(parents=True)
            base.write_text("v1.2.3\n")
        self.commit(self.work, "initial")
        self.run_git(self.work, "push", "origin", "HEAD:main")
        self.initial = self.run_git(self.work, "rev-parse", "HEAD")

    def run_git(self, directory, *args):
        return subprocess.run(["git", *args], cwd=directory, check=True, capture_output=True, text=True).stdout.strip()

    def configure(self, work):
        self.run_git(work, "config", "user.name", "release-test")
        self.run_git(work, "config", "user.email", "release-test@local")

    def commit(self, work, message):
        self.run_git(work, "add", "-A")
        self.run_git(work, "commit", "-m", message)

    def prepare_upgrade(self, product="cc-switch"):
        (self.work / product / "brand" / "BASE_TAG").write_text("v1.2.4\n")
        self.commit(self.work, "validated upgrade")

    def advance_remote(self, path):
        other = self.root / "other"
        self.run_git(self.root, "clone", str(self.remote), str(other))
        self.configure(other)
        target = other / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("another update\n")
        self.commit(other, "concurrent update")
        self.run_git(other, "push", "origin", "main")
        return self.run_git(other, "rev-parse", "HEAD")

    def publish(self, product="cc-switch"):
        return subprocess.run(
            [sys.executable, str(HERE / "push-upgrade.py"), product, "--retry-delay", "0"],
            cwd=self.work, capture_output=True, text=True,
        )

    def refs(self):
        return self.run_git(self.remote, "show-ref")

    def test_both_products_publish_main_and_tag_together(self):
        for product, suffix in (("cc-switch", "ccs"), ("open-code", "dokng")):
            self.prepare_upgrade(product)
            result = self.publish(product)
            self.assertEqual(result.returncode, 0, result.stderr)
            main = self.run_git(self.remote, "rev-parse", "refs/heads/main")
            tag = self.run_git(self.remote, "rev-parse", f"refs/tags/v1.2.4-{suffix}.1")
            self.assertEqual(main, tag)

    def test_rejected_tag_does_not_advance_main(self):
        hook = self.remote / "hooks" / "update"
        hook.write_text('#!/bin/sh\ncase "$1" in refs/tags/*) exit 1 ;; esac\n')
        hook.chmod(0o755)
        self.prepare_upgrade()
        result = self.publish()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.run_git(self.remote, "rev-parse", "main"), self.initial)
        self.assertNotIn("refs/tags/", self.refs())
        self.assertEqual(self.run_git(self.work, "tag", "--list"), "")

    def test_concurrent_other_product_is_preserved(self):
        self.prepare_upgrade()
        concurrent = self.advance_remote("open-code/brand/new-config.json")
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.run_git(self.remote, "merge-base", "--is-ancestor", concurrent, "main")
        self.assertEqual(self.run_git(self.remote, "show", "main:open-code/brand/new-config.json"), "another update")

    def test_main_race_during_push_retries_without_partial_tag(self):
        self.prepare_upgrade()
        real_git = upgrade.git
        calls = []
        concurrent = []

        def race_push(*args, **kwargs):
            if args[:2] == ("push", "--atomic"):
                calls.append(args)
                if len(calls) == 1:
                    concurrent.append(self.advance_remote("open-code/brand/concurrent.json"))
            result = real_git(*args, **kwargs)
            if args[:2] == ("push", "--atomic") and len(calls) == 1:
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("refs/tags/", self.refs())
            return result

        original = Path.cwd()
        try:
            os.chdir(self.work)
            with patch.object(upgrade, "git", race_push):
                upgrade.push_upgrade("cc-switch", delay=0)
        finally:
            os.chdir(original)
        self.assertEqual(len(calls), 2)
        self.run_git(self.remote, "merge-base", "--is-ancestor", concurrent[0], "main")
        self.assertEqual(self.run_git(self.remote, "tag", "--list"), "v1.2.4-ccs.1")

    def test_concurrent_same_product_is_not_published_unvalidated(self):
        self.prepare_upgrade()
        concurrent = self.advance_remote("cc-switch/brand/new-config.json")
        result = self.publish()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("changed validated inputs", result.stderr)
        self.assertEqual(self.run_git(self.remote, "rev-parse", "main"), concurrent)
        self.assertNotIn("refs/tags/", self.refs())

    def test_concurrent_shared_tooling_requires_validation(self):
        self.prepare_upgrade()
        concurrent = self.advance_remote("scripts/shared.py")
        result = self.publish()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.run_git(self.remote, "rev-parse", "main"), concurrent)
        self.assertNotIn("refs/tags/", self.refs())

    def test_tag_collision_uses_next_number(self):
        self.run_git(self.work, "tag", "v1.2.4-ccs.9")
        self.run_git(self.work, "push", "origin", "v1.2.4-ccs.9")
        self.prepare_upgrade()
        result = self.publish()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("refs/tags/v1.2.4-ccs.10", self.refs())

    def test_lost_push_response_does_not_create_second_release(self):
        self.prepare_upgrade()
        real_git = upgrade.git
        calls = []

        def lose_response(*args, **kwargs):
            result = real_git(*args, **kwargs)
            if args[:2] == ("push", "--atomic"):
                calls.append(args)
                return subprocess.CompletedProcess(result.args, 1, result.stdout, "lost response")
            return result

        original = Path.cwd()
        try:
            os.chdir(self.work)
            with patch.object(upgrade, "git", lose_response):
                upgrade.push_upgrade("cc-switch", delay=0)
        finally:
            os.chdir(original)
        self.assertEqual(len(calls), 1)
        self.assertEqual(self.run_git(self.remote, "tag", "--list"), "v1.2.4-ccs.1")

    def exercise_lost_ack_and_failed_probe(self, advance_main=False):
        self.prepare_upgrade()
        validated = self.run_git(self.work, "rev-parse", "HEAD")
        real_git = upgrade.git
        pushes = []
        probes = []
        concurrent = []

        def network_failure(*args, **kwargs):
            if args[0] == "ls-remote":
                probes.append(args)
                if len(probes) == 1:
                    raise subprocess.CalledProcessError(1, ["git", *args], stderr="network unavailable")
            result = real_git(*args, **kwargs)
            if args[:2] == ("push", "--atomic"):
                pushes.append(args)
                self.assertEqual(result.returncode, 0)
                if advance_main:
                    concurrent.append(self.advance_remote("open-code/brand/after-publish.json"))
                return subprocess.CompletedProcess(result.args, 1, result.stdout, "lost acknowledgement")
            return result

        original = Path.cwd()
        try:
            os.chdir(self.work)
            with patch.object(upgrade, "git", network_failure):
                tag = upgrade.push_upgrade("cc-switch", delay=0)
        finally:
            os.chdir(original)
        self.assertEqual(tag, "v1.2.4-ccs.1")
        self.assertEqual(len(pushes), 1, "an unknown transaction must not trigger another release")
        self.assertEqual(len(probes), 2)
        self.assertEqual(self.run_git(self.remote, "tag", "--list"), tag)
        self.assertEqual(self.run_git(self.remote, "rev-parse", f"refs/tags/{tag}"), validated)
        expected_main = concurrent[0] if concurrent else validated
        self.assertEqual(self.run_git(self.remote, "rev-parse", "main"), expected_main)
        self.run_git(self.remote, "merge-base", "--is-ancestor", validated, "main")

    def test_lost_ack_and_failed_probe_recover_same_publication(self):
        self.exercise_lost_ack_and_failed_probe()

    def test_lost_ack_and_failed_probe_recover_after_another_product_advances_main(self):
        self.exercise_lost_ack_and_failed_probe(advance_main=True)


class VersionGuardTests(unittest.TestCase):
    def test_numeric_version_order_and_same_version_retry(self):
        for candidate in ("v2.3.0-dokng.10", "v2.3.1-dokng.1"):
            guard.check_versions("open-code", candidate, {"latest.yml": "version: 2.3.0-dokng.10\n"})
        with self.assertRaises(ValueError):
            guard.check_versions("open-code", "v2.3.0-dokng.9", {"latest.yml": "version: 2.3.0-dokng.10\n"})

    def test_any_newer_platform_prevents_downgrade(self):
        with self.assertRaises(ValueError):
            guard.check_versions("open-code", "v2.3.0-dokng.1", {
                "latest.yml": "version: 2.2.7-dokng.1\n",
                "latest-mac.yml": "version: '2.3.0-dokng.2'\n",
            })

    def test_ccs_updater_numeric_suffix_and_download_manifest(self):
        docs = {"latest.json": json.dumps({"version": "4.0.32-2"}),
                "latest-downloads.json": json.dumps({"version": "4.0.32-ccs.3"})}
        guard.check_versions("cc-switch", "v4.0.32-ccs.3", docs)
        with self.assertRaises(ValueError):
            guard.check_versions("cc-switch", "v4.0.32-ccs.2", docs)

    def test_malformed_metadata_is_not_treated_as_first_release(self):
        for body in ("", "version: bananas\n", "version: 2.3.0-dokng.1\nversion: 2.3.0-dokng.2\n"):
            with self.assertRaises(ValueError):
                guard.check_versions("open-code", "v2.3.0-dokng.1", {"latest.yml": body})

    def test_first_publication_and_missing_objects_are_allowed(self):
        guard.check_versions("open-code", "v2.3.0-dokng.1", {})
        missing = subprocess.CompletedProcess([], 1, "", "An error occurred (NoSuchKey) when calling GetObject")
        with patch.object(guard.subprocess, "run", return_value=missing):
            self.assertEqual(guard.read_metadata("open-code", "bucket", "https://r2.invalid"), {})

    def test_access_and_network_errors_stop_publication(self):
        for error in ("An error occurred (AccessDenied)", "Connection timed out", "An error occurred (NoSuchBucket)"):
            failed = subprocess.CompletedProcess([], 1, "", error)
            with patch.object(guard.subprocess, "run", return_value=failed), self.assertRaises(RuntimeError):
                guard.read_metadata("cc-switch", "bucket", "https://r2.invalid")


if __name__ == "__main__":
    unittest.main()
