#!/usr/bin/env python3
"""Copy stdin to an existing regular file, stopping before a byte limit is exceeded."""

import os
import stat
import sys


def write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while view:
        written = os.write(fd, view)
        if written <= 0:
            raise OSError("short write while storing bounded stream")
        view = view[written:]


def main() -> int:
    if len(sys.argv) != 3:
        raise SystemExit("usage: write-bounded-stream.py OUTPUT_PATH MAX_BYTES")

    output_path = sys.argv[1]
    max_bytes = int(sys.argv[2])
    if max_bytes < 1:
        raise SystemExit("MAX_BYTES must be positive")

    flags = os.O_WRONLY | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(output_path, flags)
    try:
        target = os.fstat(fd)
        if not stat.S_ISREG(target.st_mode):
            raise OSError("bounded stream output is not a regular file")

        total = 0
        while True:
            chunk = os.read(0, min(1024 * 1024, max_bytes - total + 1))
            if not chunk:
                break
            if len(chunk) > max_bytes - total:
                raise OSError("bounded stream exceeds maximum size")
            write_all(fd, chunk)
            total += len(chunk)
        os.fsync(fd)
    finally:
        os.close(fd)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
