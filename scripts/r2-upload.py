#!/usr/bin/env python3
"""Retry a repeatable local-to-R2 upload after transient transfer failures.

The AWS CLI retries requests, but an InvalidPart at CompleteMultipartUpload
requires starting a new multipart upload. Retry the complete `aws s3 cp` using
the same local artifacts and arguments. Callers retain their upload ordering,
publication locks, checksums and metadata cache policy.
"""

import argparse
import re
import subprocess
import sys
import time
from pathlib import Path


RETRYABLE_CODES = {
    "InvalidPart", "NoSuchUpload", "RequestTimeout", "RequestTimeoutException",
    "SlowDown", "Throttling", "ThrottlingException", "TooManyRequestsException",
    "InternalError", "InternalServerError", "ServiceUnavailable", "OperationAborted",
    "429", "500", "502", "503", "504",
}
NETWORK_ERROR = re.compile(
    r"connection (?:reset|aborted|was closed|broken)|remote end closed connection|"
    r"could not connect to (?:the )?endpoint url|(?:connect|read) timeout|timed out|"
    r"temporary failure in name resolution|name or service not known|"
    r"incomplete read|broken pipe|tls handshake timeout",
    re.IGNORECASE,
)
PERMANENT_ERROR = re.compile(
    r"unknown options:|invalid choice:|parameter validation failed|"
    r"unable to locate credentials|partial credentials|invalid header value|"
    r"certificate verify failed|the config profile .+ could not be found|warning: skipping file",
    re.IGNORECASE,
)
ERROR_CODE = re.compile(r"An error occurred \(([^)]+)\)", re.IGNORECASE)


def retryable(stderr):
    if PERMANENT_ERROR.search(stderr):
        return False
    codes = ERROR_CODE.findall(stderr)
    if any(code not in RETRYABLE_CODES for code in codes):
        return False
    # Recursive uploads can report several failures. One permanent or unknown
    # error must stop the command even if another file had a transient error.
    failures = [line for line in stderr.splitlines()
                if re.search(r"upload failed:|fatal error:|An error occurred \(", line, re.IGNORECASE)]
    if failures:
        return all(ERROR_CODE.search(line) or NETWORK_ERROR.search(line) for line in failures)
    return bool(NETWORK_ERROR.search(stderr))


def upload(source, destination, aws_args, attempts=3, delay=10):
    if source == "-" or not Path(source).exists() or destination[:5] != "s3://":
        raise ValueError("Expected a repeatable local source and an s3:// destination")
    if not (Path(source).is_file() or Path(source).is_dir()):
        raise ValueError("Upload source must be a regular file or directory")
    command = ["aws", "s3", "cp", source, destination, *aws_args]
    if "--no-progress" not in aws_args:
        command.append("--no-progress")
    for attempt in range(1, attempts + 1):
        result = subprocess.run(command, capture_output=True, text=True)
        if result.stdout:
            print(result.stdout, end="", flush=True)
        if result.stderr:
            print(result.stderr, end="", file=sys.stderr, flush=True)
        if result.returncode == 0:
            return 0
        if not retryable(result.stderr) or attempt == attempts:
            return result.returncode
        wait = delay * attempt
        print(f"::warning::Transient R2 upload failure ({attempt}/{attempts}); restarting the same upload in {wait:g}s",
              file=sys.stderr, flush=True)
        time.sleep(wait)
    return 1


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--attempts", type=int, default=3)
    parser.add_argument("--retry-delay", type=float, default=10)
    parser.add_argument("source")
    parser.add_argument("destination")
    parser.add_argument("aws_args", nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if not 1 <= args.attempts <= 5 or not 0 <= args.retry_delay <= 60:
        parser.error("attempts must be 1..5 and retry delay 0..60 seconds")
    try:
        return upload(args.source, args.destination, args.aws_args, args.attempts, args.retry_delay)
    except (OSError, ValueError) as error:
        print(f"::error::{error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
