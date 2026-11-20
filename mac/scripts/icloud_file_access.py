#!/usr/bin/env python3
"""Bounded child-process access to iCloud files; never writes source files.

The macOS process-local materialization policy explicitly allows FileProvider
to download dataless content for this background reader. It changes no TCC,
account, global iCloud or filesystem permissions. Parent enforces a timeout.
"""
import argparse
import ctypes
import errno
import json
import os
from pathlib import Path
import runpy
import stat
import sys

MAX_BYTES = 32 * 1024 * 1024


def allow_materialization():
    if sys.platform != 'darwin':
        return None
    libc = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
    libc.setiopolicy_np.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_int]
    libc.setiopolicy_np.restype = ctypes.c_int
    libc.getiopolicy_np.argtypes = [ctypes.c_int, ctypes.c_int]
    libc.getiopolicy_np.restype = ctypes.c_int
    # Public macOS SDK sys/resource.h: type=3, process scope=0, ON=2.
    if libc.setiopolicy_np(3, 0, 2) != 0:
        raise OSError(ctypes.get_errno(), 'materialization_policy_failed')
    policy = libc.getiopolicy_np(3, 0)
    if policy & 3 != 2:
        raise OSError(errno.EIO, 'materialization_policy_not_applied')
    return policy


def read_input(path):
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as f:
        before = os.fstat(f.fileno())
        if not stat.S_ISREG(before.st_mode):
            raise OSError(errno.EINVAL, 'not_regular_file')
        if before.st_size > MAX_BYTES:
            raise OSError(errno.EFBIG, 'file_too_large')
        data = f.read(MAX_BYTES + 1)
        after = os.fstat(f.fileno())
    signature = lambda s: (s.st_dev, s.st_ino, s.st_size, s.st_mtime_ns)
    if len(data) > MAX_BYTES:
        raise OSError(errno.EFBIG, 'file_too_large')
    if signature(before) != signature(after) or signature(after) != signature(os.stat(path, follow_symlinks=False)):
        raise OSError(errno.EAGAIN, 'file_changed')
    sys.stdout.buffer.write(data)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument('--read', type=Path)
    group.add_argument('--weather-reader', type=Path)
    group.add_argument('--probe-policy', action='store_true')
    parser.add_argument('--directory')
    parser.add_argument('--now')
    args = parser.parse_args()
    try:
        policy = allow_materialization()
        if args.probe_policy:
            print(json.dumps({'materialization_policy': policy}))
        elif args.read:
            read_input(args.read)
        else:
            # Executes only the explicitly configured existing read-only adapter.
            helper = args.weather_reader.resolve(strict=True)
            if helper.name != 'weather_d3_reader.py' or not args.directory or not args.now:
                raise OSError(errno.EINVAL, 'invalid_weather_adapter')
            sys.path.insert(0, str(helper.parent))
            sys.argv = [str(helper), '--directory', args.directory, '--now', args.now]
            runpy.run_path(str(helper), run_name='__main__')
    except OSError as e:
        # Never serialize exception text: it may contain paths or data fragments.
        print(json.dumps({'code': errno.errorcode.get(e.errno, 'EIO'), 'type': 'OSError'}), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
