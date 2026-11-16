import contextlib
import importlib.util
import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("r2_upload", HERE / "r2-upload.py")
r2 = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r2)

INVALID_PART = "upload failed: artifact.exe to s3://bucket/run/artifact.exe An error occurred (InvalidPart) when calling the CompleteMultipartUpload operation: One or more of the specified parts could not be found.\n"


class R2UploadTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="r2-upload-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.source = self.root / "local files"
        self.source.mkdir()
        (self.source / "artifact.exe").write_bytes(b"fixed build output")

    def attempt(self, results):
        with patch.object(r2.subprocess, "run", side_effect=results) as run, \
             patch.object(r2.time, "sleep") as sleep, \
             contextlib.redirect_stderr(io.StringIO()), contextlib.redirect_stdout(io.StringIO()):
            code = r2.upload(str(self.source), "s3://bucket/run/", ["--recursive", "--checksum-algorithm", "CRC32"])
        return code, run, sleep

    def result(self, message="", code=1):
        return subprocess.CompletedProcess([], code, "", message)

    def test_invalid_part_restarts_complete_upload_with_identical_arguments(self):
        code, run, sleep = self.attempt([self.result(INVALID_PART), self.result(code=0)])
        self.assertEqual(code, 0)
        self.assertEqual(run.call_count, 2)
        self.assertEqual(run.call_args_list[0], run.call_args_list[1])
        self.assertEqual(run.call_args.args[0][:5], ["aws", "s3", "cp", str(self.source), "s3://bucket/run/"])
        sleep.assert_called_once_with(10)

    def test_exhausted_transient_error_fails_after_three_attempts(self):
        code, run, sleep = self.attempt([self.result(INVALID_PART)] * 3)
        self.assertEqual(code, 1)
        self.assertEqual(run.call_count, 3)
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [10, 20])

    def test_network_failures_retry(self):
        for message in ("upload failed: file to s3://bucket/key Read timeout on endpoint URL",
                        "Could not connect to the endpoint URL: https://r2.invalid",
                        "Connection was closed before we received a valid response",
                        "An error occurred (SlowDown) when calling UploadPart"):
            with self.subTest(message=message):
                code, run, _ = self.attempt([self.result(message), self.result(code=0)])
                self.assertEqual(code, 0)
                self.assertEqual(run.call_count, 2)

    def test_auth_parameters_and_unknown_errors_fail_immediately(self):
        for message in ("An error occurred (AccessDenied) when calling CreateMultipartUpload",
                        "An error occurred (SignatureDoesNotMatch) when calling PutObject",
                        "Unknown options: --bad-option", "Unable to locate credentials",
                        "An error occurred (BadDigest) when calling PutObject",
                        "upload failed: unknown local error"):
            with self.subTest(message=message):
                code, run, sleep = self.attempt([self.result(message)])
                self.assertEqual(code, 1)
                self.assertEqual(run.call_count, 1)
                sleep.assert_not_called()

    def test_mixed_recursive_failures_do_not_hide_permanent_errors(self):
        for extra in ("upload failed: other An error occurred (AccessDenied) when calling PutObject",
                      "upload failed: other unknown failure"):
            code, run, sleep = self.attempt([self.result(INVALID_PART + extra)])
            self.assertEqual(code, 1)
            self.assertEqual(run.call_count, 1)
            sleep.assert_not_called()

    def test_nonrepeatable_source_is_rejected_before_invoking_aws(self):
        with patch.object(r2.subprocess, "run") as run, self.assertRaises(ValueError):
            r2.upload("-", "s3://bucket/run/", [])
        run.assert_not_called()

    @unittest.skipIf(os.name == "nt", "Fixture executable uses a POSIX shebang")
    def test_cli_preserves_metadata_flags_and_retries_real_subprocess(self):
        executable = self.root / "aws"
        calls = self.root / "calls.jsonl"
        executable.write_text(
            f"#!{sys.executable}\n"
            "import json, os, pathlib, sys\n"
            "path = pathlib.Path(os.environ['R2_TEST_CALLS'])\n"
            "first = not path.exists()\n"
            "with path.open('a') as f: f.write(json.dumps(sys.argv[1:]) + '\\n')\n"
            f"if first: print({INVALID_PART!r}, file=sys.stderr); sys.exit(1)\n"
        )
        executable.chmod(0o755)
        source = self.source / "latest.yml"
        source.write_text("version: 2.3.0-dokng.1\n")
        flags = ["--endpoint-url", "https://r2.invalid", "--checksum-algorithm", "CRC32",
                 "--cache-control", "no-cache,max-age=0,must-revalidate", "--content-type", "text/yaml"]
        result = subprocess.run(
            [sys.executable, str(HERE / "r2-upload.py"), "--retry-delay", "0", str(source), "s3://bucket/open-code/latest.yml", *flags],
            env={**os.environ, "PATH": str(self.root) + os.pathsep + os.environ.get("PATH", ""), "R2_TEST_CALLS": str(calls)},
            text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        attempts = [json.loads(line) for line in calls.read_text().splitlines()]
        self.assertEqual(len(attempts), 2)
        self.assertEqual(attempts[0], attempts[1])
        self.assertEqual(attempts[0], ["s3", "cp", str(source), "s3://bucket/open-code/latest.yml", *flags, "--no-progress"])
        self.assertEqual(source.read_text(), "version: 2.3.0-dokng.1\n")


if __name__ == "__main__":
    unittest.main()
