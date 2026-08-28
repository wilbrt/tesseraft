#!/usr/bin/env python3
"""Helper-free, handle-confined tracked Git snapshot for local approval review.

The process accepts one bounded JSON request on stdin and emits one JSON result.
It invokes only fixed non-converting Git plumbing and reads worktree files with
openat-style directory descriptors plus O_NOFOLLOW. Repository helpers are
never executed.
"""
from __future__ import annotations

import base64
import difflib
import hashlib
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
from typing import Any

MAX_FILES = 10_000
MAX_PATH_BYTES = 4096
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_SCAN_BYTES = 64 * 1024 * 1024


def fail(code: str, message: str, **details: Any) -> "NoReturn":
    print(json.dumps({"ok": False, "error": {"code": code, "message": message, "details": details}}))
    raise SystemExit(2)


def git(repo: str, *args: str, allow_one: bool = False) -> bytes:
    env = os.environ.copy()
    env.update({"GIT_OPTIONAL_LOCKS": "0", "GIT_NO_LAZY_FETCH": "1", "GIT_NO_REPLACE_OBJECTS": "1", "GIT_PAGER": "cat"})
    result = subprocess.run(["git", "-c", "core.fsmonitor=false", "--no-pager", *args], cwd=repo,
                            stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            env=env, timeout=20, check=False)
    if result.returncode and not (allow_one and result.returncode == 1):
        fail("git_snapshot_failed", "Git snapshot plumbing failed", operation=args[0], exit=result.returncode,
             stderr=result.stderr.decode("utf-8", "replace")[:1000])
    return result.stdout


def safe_path(raw: bytes) -> str:
    try:
        value = raw.decode("utf-8", "strict")
    except UnicodeDecodeError:
        fail("unsupported_git_path", "Tracked paths must be valid UTF-8")
    if (not value or value.startswith("/") or "\\" in value or "\x00" in value or
            any(part in ("", ".", "..") for part in value.split("/")) or
            len(raw) > MAX_PATH_BYTES or any(ord(ch) < 32 for ch in value)):
        fail("unsafe_worktree_path", "Tracked path is not safely reviewable")
    return value


def tree_entries(repo: str, revision: str) -> dict[str, tuple[str, str]]:
    output = git(repo, "ls-tree", "-rz", "--full-tree", revision)
    entries: dict[str, tuple[str, str]] = {}
    for record in filter(None, output.split(b"\0")):
        try:
            metadata, raw_path = record.split(b"\t", 1)
            mode, kind, oid = metadata.decode("ascii").split(" ")
        except ValueError:
            fail("malformed_git_metadata", "Malformed ls-tree output")
        path = safe_path(raw_path)
        if kind != "blob" or mode not in ("100644", "100755"):
            fail("unsupported_tracked_type", "Only regular tracked files are reviewable", path=path, mode=mode)
        if path in entries:
            fail("duplicate_git_path", "Duplicate tracked path", path=path)
        entries[path] = (mode, oid)
    return entries


def index_entries(repo: str) -> dict[str, tuple[str, str]]:
    output = git(repo, "ls-files", "--stage", "-z")
    entries: dict[str, tuple[str, str]] = {}
    for record in filter(None, output.split(b"\0")):
        try:
            metadata, raw_path = record.split(b"\t", 1)
            mode, oid, stage = metadata.decode("ascii").split(" ")
        except ValueError:
            fail("malformed_git_metadata", "Malformed index output")
        path = safe_path(raw_path)
        if stage != "0":
            fail("unsupported_conflicted_index", "Conflicted index entries are not reviewable", path=path)
        if mode not in ("100644", "100755"):
            fail("unsupported_tracked_type", "Only regular index files are reviewable", path=path, mode=mode)
        if path in entries:
            fail("duplicate_git_path", "Duplicate index path", path=path)
        entries[path] = (mode, oid)
    return entries


def assert_conversion_free(repo: str, head: dict[str, tuple[str, str]], index: dict[str, tuple[str, str]]) -> None:
    autocrlf = git(repo, "config", "--get", "core.autocrlf", allow_one=True).decode("utf-8", "strict").strip().lower()
    names = git(repo, "config", "--name-only", "--get-regexp",
                r"^(core\.eol|core\.attributesfile|filter\..*\.(clean|smudge|process|required))$",
                allow_one=True).decode("utf-8", "strict").strip()
    if (autocrlf and autocrlf != "false") or names:
        fail("unsupported_git_conversion", "Git-diff review requires a conversion-free worktree")
    if any(path == ".gitattributes" or path.endswith("/.gitattributes") for path in set(head) | set(index)):
        fail("unsupported_git_conversion", "Tracked attribute files are not supported")
    git_attributes = git(repo, "rev-parse", "--git-path", "info/attributes").decode("utf-8", "strict").strip()
    candidates = [Path(repo) / git_attributes if not os.path.isabs(git_attributes) else Path(git_attributes),
                  Path.home() / ".gitattributes", Path.home() / ".config" / "git" / "attributes",
                  Path("/etc/gitattributes")]
    if any(candidate.exists() for candidate in candidates):
        fail("unsupported_git_conversion", "An effective attributes source may affect tracked content")


def fingerprint(st: os.stat_result) -> tuple[int, int, int, int, int]:
    return (st.st_dev, st.st_ino, st.st_size, st.st_mtime_ns, st.st_ctime_ns)


def secure_stat(root_fd: int, rel: str) -> tuple[int, int, int, int, int] | None:
    if not rel:
        return fingerprint(os.fstat(root_fd))
    flags_dir = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    current = root_fd
    opened: list[int] = []
    try:
        parts = rel.split("/")
        for component in parts[:-1]:
            fd = os.open(component, flags_dir, dir_fd=current)
            opened.append(fd); current = fd
        try:
            return fingerprint(os.stat(parts[-1], dir_fd=current, follow_symlinks=False))
        except FileNotFoundError:
            return None
    finally:
        for fd in reversed(opened):
            os.close(fd)


def secure_read(root_fd: int, rel: str) -> tuple[bytes | None, list[tuple[str, tuple[int, int, int, int, int]]]]:
    flags_dir = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    flags_file = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
    if not hasattr(os, "O_NOFOLLOW") or os.open not in getattr(os, "supports_dir_fd", set()):
        fail("secure_worktree_traversal_unavailable", "Directory-FD no-follow traversal is unavailable")
    opened: list[int] = []
    current = root_fd
    fingerprints: list[tuple[str, tuple[int, int, int, int, int]]] = [("", fingerprint(os.fstat(root_fd)))]
    traversed: list[str] = []
    try:
        parts = rel.split("/")
        for component in [None, *parts[:-1]]:
            try:
                os.stat(".gitattributes", dir_fd=current, follow_symlinks=False)
                fail("unsupported_git_conversion", "A worktree attribute file may affect tracked content", path=rel)
            except FileNotFoundError:
                pass
            if component is None:
                continue
            fd = os.open(component, flags_dir, dir_fd=current)
            opened.append(fd)
            current = fd
            st = os.fstat(fd)
            if not stat.S_ISDIR(st.st_mode):
                fail("unsafe_worktree_path", "Tracked ancestor is not a directory", path=rel)
            traversed.append(component)
            fingerprints.append(("/".join(traversed), fingerprint(st)))
        try:
            fd = os.open(parts[-1], flags_file, dir_fd=current)
        except FileNotFoundError:
            return None, fingerprints
        except OSError:
            fail("unsafe_worktree_path", "Tracked file could not be opened without following links", path=rel)
        opened.append(fd)
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode):
            fail("unsupported_tracked_type", "Tracked worktree entry is not a regular file", path=rel)
        if before.st_size > MAX_FILE_BYTES:
            fail("review_file_too_large", "Tracked file exceeds review scan bound", path=rel)
        chunks: list[bytes] = []
        remaining = MAX_FILE_BYTES + 1
        while remaining:
            chunk = os.read(fd, min(65536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        after = os.fstat(fd)
        if len(data) > MAX_FILE_BYTES or (before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns):
            fail("unstable_worktree_snapshot", "Tracked file changed while being read", path=rel)
        fingerprints.append((rel, fingerprint(after)))
        return data, fingerprints
    finally:
        for fd in reversed(opened):
            os.close(fd)


def blob_oid(data: bytes, algorithm: str) -> str:
    digest = hashlib.new(algorithm)
    digest.update(f"blob {len(data)}\0".encode("ascii"))
    digest.update(data)
    return digest.hexdigest()


def text(data: bytes, path: str) -> str:
    if b"\0" in data:
        fail("unsupported_binary_diff", "Binary tracked changes are not reviewable", path=path)
    try:
        value = data.decode("utf-8", "strict")
    except UnicodeDecodeError:
        fail("unsupported_text_encoding", "Tracked changes must be valid UTF-8", path=path)
    if value and not value.endswith("\n"):
        fail("unsupported_no_final_newline", "Changed text files must end with a newline", path=path)
    return value


def patch_for(path: str, old: bytes | None, new: bytes | None) -> str:
    old_text = text(old or b"", path)
    new_text = text(new or b"", path)
    old_name = "/dev/null" if old is None else f"a/{path}"
    new_name = "/dev/null" if new is None else f"b/{path}"
    body = list(difflib.unified_diff(old_text.splitlines(True), new_text.splitlines(True),
                                     fromfile=old_name, tofile=new_name, n=3, lineterm="\n"))
    if not body:
        return ""
    return f"diff --git a/{path} b/{path}\n" + "".join(body)


def main() -> None:
    try:
        request = json.loads(sys.stdin.buffer.read(64 * 1024))
        supplied = os.path.realpath(str(request["repo"]))
        max_diff = int(request["max_diff_bytes"])
    except Exception:
        fail("invalid_snapshot_request", "Malformed snapshot request")
    if not (1 <= max_diff <= 10 * 1024 * 1024):
        fail("invalid_review_diff_bound", "Invalid review diff byte bound")
    repo = git(supplied, "rev-parse", "--show-toplevel").decode("utf-8", "strict").strip()
    repo = os.path.realpath(repo)
    if repo != supplied and not supplied.startswith(repo + os.sep):
        fail("unsafe_worktree_path", "Resolved repository differs from requested worktree")
    head_oid = git(repo, "rev-parse", "HEAD^{tree}").decode("ascii").strip()
    index_fingerprint = hashlib.sha256(git(repo, "ls-files", "--stage", "-z")).hexdigest()
    object_format = git(repo, "rev-parse", "--show-object-format").decode("ascii").strip()
    if object_format not in ("sha1", "sha256"):
        fail("unsupported_object_format", "Unsupported Git object format")
    head = tree_entries(repo, head_oid)
    index = index_entries(repo)
    if len(set(head) | set(index)) > MAX_FILES:
        fail("review_file_count_exceeded", "Tracked file count exceeds review bound")
    assert_conversion_free(repo, head, index)
    root_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        root_fd = os.open(repo, root_flags)
    except OSError:
        fail("secure_worktree_traversal_unavailable", "Could not open worktree root securely")
    patches: list[str] = []
    scanned = 0
    context_receipts: list[tuple[str, list[tuple[str, tuple[int, int, int, int, int]]]]] = []
    try:
        for path in sorted(set(head) | set(index)):
            old_entry = head.get(path)
            new_entry = index.get(path)
            if old_entry and new_entry and old_entry[0] != new_entry[0]:
                fail("unsupported_mode_change", "Tracked mode changes are not reviewable", path=path)
            new_data, receipts = secure_read(root_fd, path) if new_entry else (None, [])
            scanned += len(new_data or b"")
            if scanned > MAX_SCAN_BYTES:
                fail("review_scan_too_large", "Aggregate review scan exceeds bound")
            context_receipts.append((path, receipts))
            current_oid = blob_oid(new_data, object_format) if new_data is not None else None
            old_oid = old_entry[1] if old_entry else None
            if old_oid == current_oid:
                continue
            old_data = git(repo, "cat-file", "blob", old_oid) if old_oid else None
            patch = patch_for(path, old_data, new_data)
            if patch:
                patches.append(patch)
                if sum(len(item.encode("utf-8")) for item in patches) > max_diff:
                    fail("review_diff_too_large", "Git review diff exceeds authored byte bound", limit=max_diff)
        expected: dict[str, tuple[int, int, int, int, int]] = {}
        for _, receipts in context_receipts:
            for label, value in receipts:
                prior = expected.get(label)
                if prior is not None and prior != value:
                    fail("unstable_worktree_snapshot", "Tracked namespace changed during snapshot", path=label)
                expected[label] = value
        for label, value in expected.items():
            if secure_stat(root_fd, label) != value:
                fail("unstable_worktree_snapshot", "Tracked namespace changed before publication", path=label)
    finally:
        os.close(root_fd)
    if git(repo, "rev-parse", "HEAD^{tree}").decode("ascii").strip() != head_oid or hashlib.sha256(git(repo, "ls-files", "--stage", "-z")).hexdigest() != index_fingerprint:
        fail("unstable_worktree_snapshot", "HEAD or index changed during snapshot")
    diff = "".join(patches).encode("utf-8")
    if not diff:
        fail("no_reviewable_changes", "There are no tracked Git changes to review")
    print(json.dumps({"ok": True, "diff_base64": base64.b64encode(diff).decode("ascii"),
                      "size": len(diff), "head_tree": head_oid, "index_fingerprint": index_fingerprint,
                      "context_fingerprint": hashlib.sha256(repr(context_receipts).encode()).hexdigest()}))


if __name__ == "__main__":
    main()
