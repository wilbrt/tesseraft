#!/usr/bin/env python3
"""Helper-free, handle-confined tracked Git snapshot for local approval review.

The process accepts one bounded JSON request on stdin and emits one JSON result.
It invokes only fixed non-converting Git plumbing and reads worktree files with
openat-style directory descriptors plus O_NOFOLLOW. Repository helpers are
never executed.
"""
from __future__ import annotations

import base64
import ctypes
import difflib
import hashlib
import json
import os
from pathlib import Path
import select
import stat
import struct
import subprocess
import sys
from typing import Any

MAX_FILES = 10_000
MAX_PATH_BYTES = 4096
MAX_FILE_BYTES = 8 * 1024 * 1024
MAX_SCAN_BYTES = 64 * 1024 * 1024
MAX_WATCHES = 20_000


class KernelWatcher:
    """Retained supported-platform mutation evidence; unsupported kernels fail closed."""

    def __init__(self, paths: list[str]):
        unique = sorted(set(os.path.abspath(path) for path in paths if os.path.lexists(path)))
        if not unique or len(unique) > MAX_WATCHES:
            fail("snapshot_watch_unavailable", "Snapshot watch set is empty or exceeds its bound", count=len(unique))
        self.provider = ""
        self.fd = -1
        self.fds: list[int] = []
        self.kqueue: Any = None
        if sys.platform == "darwin" and hasattr(select, "kqueue"):
            self.provider = "kqueue"
            self.kqueue = select.kqueue()
            flags = getattr(os, "O_EVTONLY", os.O_RDONLY) | getattr(os, "O_NOFOLLOW", 0)
            notes = (select.KQ_NOTE_WRITE | select.KQ_NOTE_DELETE | select.KQ_NOTE_RENAME |
                     select.KQ_NOTE_EXTEND | select.KQ_NOTE_LINK | select.KQ_NOTE_REVOKE)
            try:
                current_path = ""
                for path in unique:
                    current_path = path
                    fd = os.open(path, flags)
                    self.fds.append(fd)
                    self.kqueue.control([select.kevent(fd, filter=select.KQ_FILTER_VNODE,
                                                       flags=select.KQ_EV_ADD | select.KQ_EV_CLEAR,
                                                       fflags=notes)], 0, 0)
            except OSError as error:
                self.close()
                fail("snapshot_watch_unavailable", "Could not install a no-follow kqueue watch",
                     path=current_path, errno=error.errno)
        elif sys.platform.startswith("linux"):
            self.provider = "inotify"
            libc = ctypes.CDLL(None, use_errno=True)
            init = libc.inotify_init1
            init.argtypes = [ctypes.c_int]
            init.restype = ctypes.c_int
            self.fd = init(os.O_NONBLOCK | getattr(os, "O_CLOEXEC", 0))
            if self.fd < 0:
                fail("snapshot_watch_unavailable", "Could not initialize inotify", errno=ctypes.get_errno())
            add = libc.inotify_add_watch
            add.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
            add.restype = ctypes.c_int
            # IN_MODIFY, IN_CLOSE_WRITE, namespace changes, and self-delete/move.
            # Do not subscribe to access/open/close-without-write read noise.
            mask = 0x02000FCA  # plus IN_DONT_FOLLOW
            for path in unique:
                if add(self.fd, os.fsencode(path), mask) < 0:
                    self.close()
                    fail("snapshot_watch_unavailable", "Could not install an inotify watch", errno=ctypes.get_errno())
        else:
            fail("snapshot_watch_unavailable", "Kernel snapshot watches are unsupported on this platform",
                 platform=sys.platform)
        self.count = len(unique)

    def changed(self) -> tuple[bool, bool]:
        if self.provider == "kqueue":
            events = self.kqueue.control(None, max(1, self.count), 0)
            return bool(events), False
        changed = False
        overflow = False
        while True:
            try:
                data = os.read(self.fd, 1024 * 1024)
            except BlockingIOError:
                break
            if not data:
                break
            changed = True
            offset = 0
            while offset + 16 <= len(data):
                _, mask, _, name_len = struct.unpack_from("iIII", data, offset)
                overflow = overflow or bool(mask & 0x00004000)  # IN_Q_OVERFLOW
                offset += 16 + name_len
        return changed, overflow

    def close(self) -> None:
        if self.kqueue is not None:
            self.kqueue.close()
            self.kqueue = None
        for fd in self.fds:
            try: os.close(fd)
            except OSError: pass
        self.fds = []
        if self.fd >= 0:
            try: os.close(self.fd)
            except OSError: pass
            self.fd = -1


def watch_paths(repo: str, tracked: set[str]) -> list[str]:
    paths = [repo]
    for rel in tracked:
        current = Path(repo)
        for component in rel.split("/")[:-1]:
            current /= component
            paths.append(str(current))
    git_dir = Path(git(repo, "rev-parse", "--absolute-git-dir").decode("utf-8", "strict").strip())
    common_raw = git(repo, "rev-parse", "--git-common-dir").decode("utf-8", "strict").strip()
    common_dir = Path(common_raw if os.path.isabs(common_raw) else os.path.join(repo, common_raw))
    git_path = lambda name: Path(git(repo, "rev-parse", "--git-path", name).decode("utf-8", "strict").strip())
    metadata = [git_dir, common_dir, git_dir / "HEAD", git_path("index"),
                common_dir / "config", git_dir / "config.worktree", common_dir / "packed-refs",
                git_path("info/attributes"), Path.home() / ".gitconfig",
                Path.home() / ".gitattributes", Path.home() / ".config/git/config",
                Path.home() / ".config/git/attributes", Path("/etc/gitconfig"), Path("/etc/gitattributes")]
    symbolic = git(repo, "symbolic-ref", "-q", "HEAD", allow_one=True).decode("utf-8", "strict").strip()
    if symbolic:
        metadata.append(common_dir / symbolic)
    for candidate in metadata:
        candidate = candidate if candidate.is_absolute() else Path(repo) / candidate
        for target in (candidate, candidate.parent):
            if target.is_symlink():
                # Git follows configured metadata aliases. Watch the lexical
                # parent for alias replacement and the resolved target for
                # content/namespace mutation; never open the link itself.
                paths.append(str(target.parent))
                paths.append(os.path.realpath(target))
            else:
                paths.append(str(target))
    return paths


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


def test_barrier(name: str) -> None:
    directory = os.environ.get("TESSERAFT_TEST_SNAPSHOT_BARRIER_DIR")
    if not directory:
        return
    root = Path(directory)
    root.mkdir(parents=True, exist_ok=True)
    (root / f"{name}.ready").write_text("ready\n")
    for _ in range(500):
        if (root / f"{name}.continue").exists():
            return
        import time
        time.sleep(0.01)
    fail("snapshot_test_barrier_timeout", "Snapshot test barrier timed out", barrier=name)


def assert_stable(repo: str, root_fd: int, expected: dict[str, tuple[int, int, int, int, int]],
                  head_oid: str, index_fingerprint: str, watcher: KernelWatcher) -> None:
    for label, value in expected.items():
        if secure_stat(root_fd, label) != value:
            fail("unstable_worktree_snapshot", "Tracked namespace changed through evidence publication", path=label)
    if (git(repo, "rev-parse", "HEAD^{tree}").decode("ascii").strip() != head_oid or
            hashlib.sha256(git(repo, "ls-files", "--stage", "-z")).hexdigest() != index_fingerprint):
        fail("unstable_worktree_snapshot", "HEAD or index changed through evidence publication")
    changed, overflow = watcher.changed()
    if overflow:
        fail("snapshot_watch_overflow", "Kernel snapshot watch queue overflowed")
    if changed:
        fail("unstable_worktree_snapshot", "Watched Git namespace changed through evidence publication")


def main() -> None:
    try:
        raw = sys.stdin.buffer.readline(64 * 1024 + 1)
        if len(raw) > 64 * 1024 or not raw.endswith(b"\n"):
            raise ValueError("unbounded request")
        request = json.loads(raw)
        supplied = os.path.realpath(str(request["repo"]))
        max_diff = int(request["max_diff_bytes"])
    except Exception:
        fail("invalid_snapshot_request", "Malformed snapshot request")
    if not (1 <= max_diff <= 10 * 1024 * 1024):
        fail("invalid_review_diff_bound", "Invalid review diff byte bound")
    repo = os.path.realpath(git(supplied, "rev-parse", "--show-toplevel").decode("utf-8", "strict").strip())
    if repo != supplied and not supplied.startswith(repo + os.sep):
        fail("unsafe_worktree_path", "Resolved repository differs from requested worktree")
    head_oid = git(repo, "rev-parse", "HEAD^{tree}").decode("ascii").strip()
    index_fingerprint = hashlib.sha256(git(repo, "ls-files", "--stage", "-z")).hexdigest()
    object_format = git(repo, "rev-parse", "--show-object-format").decode("ascii").strip()
    if object_format not in ("sha1", "sha256"):
        fail("unsupported_object_format", "Unsupported Git object format")
    head = tree_entries(repo, head_oid)
    index = index_entries(repo)
    tracked = set(head) | set(index)
    if len(tracked) > MAX_FILES:
        fail("review_file_count_exceeded", "Tracked file count exceeds review bound")
    watcher = KernelWatcher(watch_paths(repo, tracked))
    root_fd = -1
    try:
        assert_conversion_free(repo, head, index)
        root_flags = os.O_RDONLY | getattr(os, "O_DIRECTORY", 0) | getattr(os, "O_NOFOLLOW", 0)
        try:
            root_fd = os.open(repo, root_flags)
        except OSError:
            fail("secure_worktree_traversal_unavailable", "Could not open worktree root securely")
        patches: list[str] = []
        scanned = 0
        context_receipts: list[tuple[str, list[tuple[str, tuple[int, int, int, int, int]]]]] = []
        for path in sorted(tracked):
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
        assert_stable(repo, root_fd, expected, head_oid, index_fingerprint, watcher)
        diff = "".join(patches).encode("utf-8")
        if not diff:
            fail("no_reviewable_changes", "There are no tracked Git changes to review")
        digest = hashlib.sha256(diff).hexdigest()
        test_barrier("prepared")
        print(json.dumps({"ok": True, "phase": "prepared",
                          "diff_base64": base64.b64encode(diff).decode("ascii"), "sha256": digest,
                          "size": len(diff), "head_tree": head_oid, "index_fingerprint": index_fingerprint,
                          "context_fingerprint": hashlib.sha256(repr(context_receipts).encode()).hexdigest(),
                          "watch_provider": watcher.provider, "watch_count": watcher.count}), flush=True)
        readable, _, _ = select.select([sys.stdin.buffer], [], [], 30)
        if not readable:
            fail("snapshot_publication_timeout", "Timed out waiting for evidence publication")
        acknowledgement = json.loads(sys.stdin.buffer.readline(4097))
        if acknowledgement != {"command": "published", "sha256": digest}:
            fail("invalid_snapshot_publication", "Evidence publication acknowledgement did not match prepared bytes")
        test_barrier("published")
        assert_stable(repo, root_fd, expected, head_oid, index_fingerprint, watcher)
        print(json.dumps({"ok": True, "phase": "confirmed", "sha256": digest,
                          "watch_provider": watcher.provider, "watch_count": watcher.count,
                          "watch_overflow": False}), flush=True)
    finally:
        if root_fd >= 0:
            os.close(root_fd)
        watcher.close()


if __name__ == "__main__":
    main()
