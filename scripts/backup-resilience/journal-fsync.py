#!/usr/bin/python3
"""Fsync one trusted drill journal path without following symlinks."""

import os
import stat
import sys


def die() -> "None":
    raise SystemExit(65)


if len(sys.argv) != 3 or sys.argv[1] not in {"file-and-directory", "directory"}:
    die()

mode = sys.argv[1]
path = sys.argv[2]
if not os.path.isabs(path) or path in {"/", "/var", "/var/lib", "/run"}:
    die()

flags = os.O_RDONLY | os.O_CLOEXEC | getattr(os, "O_NOFOLLOW", 0)
directory_flags = flags | getattr(os, "O_DIRECTORY", 0)

if mode == "file-and-directory":
    file_descriptor = os.open(path, flags)
    try:
        metadata = os.fstat(file_descriptor)
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            die()
        os.fsync(file_descriptor)
    finally:
        os.close(file_descriptor)
    directory = os.path.dirname(path)
else:
    directory = path

directory_descriptor = os.open(directory, directory_flags)
try:
    metadata = os.fstat(directory_descriptor)
    if not stat.S_ISDIR(metadata.st_mode):
        die()
    os.fsync(directory_descriptor)
finally:
    os.close(directory_descriptor)
