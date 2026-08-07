#!/usr/bin/env python3
"""Redact sensitive diagnostics before retaining a bounded output tail."""

from __future__ import annotations

import os
import re
import stat
import sys

AUTHORIZATION = re.compile(br"authorization[ \t]*:", re.IGNORECASE)
HOOK_TOKEN = re.compile(br"OPENCLAW_HOOKS_TOKEN[ \t]*=")
REDACTED_LINE = b"[REDACTED SENSITIVE DIAGNOSTIC LINE]"
REDACTED_VALUE = b"[REDACTED]"


def redact_known_values(value: bytes, secrets: list[bytes]) -> bytes:
    for secret in secrets:
        value = value.replace(secret, REDACTED_VALUE)
    return value


def append_bounded(tail: bytearray, value: bytes, maximum: int) -> None:
    tail.extend(value)
    if len(tail) > maximum:
        del tail[:-maximum]


def main() -> int:
    if len(sys.argv) != 4:
        return 64
    output_path, maximum_raw, secrets_path = sys.argv[1:]
    try:
        maximum = int(maximum_raw)
    except ValueError:
        return 64
    if maximum <= 0:
        return 64

    with open(secrets_path, "rb") as handle:
        secrets = [line.rstrip(b"\r\n") for line in handle if line.rstrip(b"\r\n")]

    retain = max(maximum, max((len(secret) for secret in secrets), default=0) + 256)
    tail = bytearray()
    current = bytearray()
    sensitive_line = False

    while True:
        chunk = sys.stdin.buffer.read(16384)
        if not chunk:
            break
        start = 0
        while start < len(chunk):
            newline = chunk.find(b"\n", start)
            end = len(chunk) if newline < 0 else newline
            if not sensitive_line:
                current.extend(chunk[start:end])
                current[:] = redact_known_values(bytes(current), secrets)
                if AUTHORIZATION.search(current) or HOOK_TOKEN.search(current):
                    sensitive_line = True
                    current.clear()
                elif len(current) > retain * 2:
                    del current[:-retain]
            if newline < 0:
                break
            if sensitive_line:
                append_bounded(tail, REDACTED_LINE + b"\n", maximum)
            else:
                append_bounded(tail, bytes(current) + b"\n", maximum)
            current.clear()
            sensitive_line = False
            start = newline + 1

    if sensitive_line:
        append_bounded(tail, REDACTED_LINE, maximum)
    elif current:
        append_bounded(tail, redact_known_values(bytes(current), secrets), maximum)

    flags = os.O_WRONLY | os.O_TRUNC | getattr(os, "O_NOFOLLOW", 0)
    descriptor = os.open(output_path, flags)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise OSError("spawn output target is not regular")
        os.write(descriptor, tail)
    finally:
        os.close(descriptor)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
