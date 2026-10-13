#!/usr/bin/env python3
"""Create many log files and keep writing to all of them.

The Datadog Agent's log collector opens one tailer per file. A few hundred
files is cheap. 1500 to 2000 active files is enough to show up as Agent CPU,
which is the point of this scenario.

The writer stays in the foreground. Ctrl-C stops it. Files are capped and
the run stops on its own, so this does not fill the disk if it is left going.

    python3 scripts/fanout-logs.py --prepare --files 1800
    python3 scripts/fanout-logs.py --files 1800 --rate 2000 --duration 600
    python3 scripts/fanout-logs.py --clean
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time
from pathlib import Path

DEFAULT_DIR = Path("var/fanout-logs")
DEFAULT_FILES = 1800
DEFAULT_RATE = 200
DEFAULT_MAX_BYTES = 256 * 1024
DEFAULT_DURATION = 600

LEVELS = ("info", "info", "info", "warn", "error")
stop = False


def on_stop(_signum: int, _frame: object) -> None:
    global stop
    stop = True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dir", type=Path, default=DEFAULT_DIR, help="directory of log files")
    parser.add_argument("--files", type=int, default=DEFAULT_FILES, help="how many files to keep active")
    parser.add_argument(
        "--rate",
        type=int,
        default=DEFAULT_RATE,
        help="total lines per second, spread across every file",
    )
    parser.add_argument(
        "--max-bytes",
        type=int,
        default=DEFAULT_MAX_BYTES,
        help="truncate a file once it passes this size",
    )
    parser.add_argument(
        "--duration",
        type=int,
        default=DEFAULT_DURATION,
        help="seconds to run, then exit. 0 runs until Ctrl-C",
    )
    parser.add_argument(
        "--prepare",
        action="store_true",
        help="create the directory and the files, then exit",
    )
    parser.add_argument(
        "--clean",
        action="store_true",
        help="delete the files this script created",
    )
    args = parser.parse_args()
    if args.files < 1 or args.files > 5000:
        parser.error("--files must be between 1 and 5000")
    if args.rate < 1:
        parser.error("--rate must be at least 1")
    if args.max_bytes < 1024:
        parser.error("--max-bytes must be at least 1024")
    if args.dir.name != "fanout-logs":
        parser.error("refusing to write outside a directory named fanout-logs")
    return args


def log_path(directory: Path, index: int) -> Path:
    return directory / f"app-{index:04d}.log"


def prepare(directory: Path, count: int) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for index in range(count):
        path = log_path(directory, index)
        if not path.exists():
            path.touch()
    print(f"prepared {count} files in {directory.resolve()}")


def clean(directory: Path) -> None:
    if not directory.is_dir():
        print(f"nothing to remove at {directory}")
        return
    removed = 0
    for path in directory.glob("app-*.log"):
        path.unlink()
        removed += 1
    print(f"removed {removed} files from {directory.resolve()}")


def write_forever(directory: Path, count: int, rate: int, max_bytes: int, duration: int) -> None:
    paths = [log_path(directory, index) for index in range(count)]
    missing = [path for path in paths if not path.exists()]
    if missing:
        sys.exit(f"{len(missing)} files are missing. Run with --prepare first.")

    interval = 1.0 / rate
    deadline = time.monotonic() + duration if duration else None
    written = 0
    started = time.monotonic()
    next_report = started + 10
    index = 0

    print(
        f"writing {rate} lines/sec across {count} files in {directory.resolve()} "
        f"(cap {max_bytes} bytes each)"
    )
    while not stop:
        now = time.monotonic()
        if deadline is not None and now >= deadline:
            break

        path = paths[index]
        index = (index + 1) % count
        line = json.dumps(
            {
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                "service": "voyager-fanout",
                "status": LEVELS[written % len(LEVELS)],
                "file": path.name,
                "message": "fanout log line",
                "n": written,
            },
            separators=(",", ":"),
        )
        with path.open("a", encoding="utf-8") as handle:
            handle.write(line + "\n")
            if handle.tell() > max_bytes:
                handle.seek(0)
                handle.truncate()
        written += 1

        if now >= next_report:
            elapsed = max(now - started, 0.001)
            print(f"wrote {written} lines ({written / elapsed:.0f}/sec)")
            next_report = now + 10

        sleep_for = interval - (time.monotonic() - now)
        if sleep_for > 0:
            time.sleep(sleep_for)

    print(f"stopped after {written} lines")


def main() -> None:
    args = parse_args()
    signal.signal(signal.SIGINT, on_stop)
    signal.signal(signal.SIGTERM, on_stop)

    if args.clean:
        clean(args.dir)
        return

    prepare(args.dir, args.files)
    if args.prepare:
        return

    write_forever(args.dir, args.files, args.rate, args.max_bytes, args.duration)


if __name__ == "__main__":
    main()
