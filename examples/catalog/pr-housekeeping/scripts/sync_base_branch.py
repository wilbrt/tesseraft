#!/usr/bin/env python3
import json
import pathlib
import subprocess
import sys

from path_utils import resolve_repo_root


def git(repo_root, *args):
    return subprocess.run(
        ["git", *args],
        cwd=repo_root,
        text=True,
        capture_output=True,
    )


def write_record(path, record):
    path.write_text(json.dumps(record, indent=2) + "\n")


def main():
    request = json.load(sys.stdin)
    inputs = request.get("inputs", {})
    run_dir = pathlib.Path(request["paths"]["run_dir"])
    repo_root = resolve_repo_root(request)
    base_branch = str(inputs.get("base-branch") or "main")
    out_dir = run_dir / "housekeeping"
    out_dir.mkdir(parents=True, exist_ok=True)
    output_path = out_dir / "base-sync.json"

    branch_check = git(repo_root, "check-ref-format", "--branch", base_branch)
    current = git(repo_root, "branch", "--show-current")
    before = git(repo_root, "rev-parse", "HEAD")
    record = {
        "repo_root": str(repo_root),
        "base_branch": base_branch,
        "current_branch": current.stdout.strip(),
        "before_commit": before.stdout.strip(),
        "command": ["git", "pull", "--ff-only", "origin", base_branch],
    }

    if branch_check.returncode != 0:
        record.update({"status": "error", "error": branch_check.stderr.strip() or "invalid base branch"})
        write_record(output_path, record)
        print(record["error"], file=sys.stderr)
        return 1
    if current.returncode != 0 or before.returncode != 0:
        error = current.stderr.strip() or before.stderr.strip() or "repo-root is not a Git checkout"
        record.update({"status": "error", "error": error})
        write_record(output_path, record)
        print(error, file=sys.stderr)
        return 1
    if record["current_branch"] != base_branch:
        error = f"repo-root must have {base_branch!r} checked out; found {record['current_branch']!r}"
        record.update({"status": "error", "error": error})
        write_record(output_path, record)
        print(error, file=sys.stderr)
        return 1

    pulled = git(repo_root, "pull", "--ff-only", "origin", base_branch)
    after = git(repo_root, "rev-parse", "HEAD")
    record.update({
        "status": "ok" if pulled.returncode == 0 and after.returncode == 0 else "error",
        "after_commit": after.stdout.strip(),
        "updated": before.stdout.strip() != after.stdout.strip(),
        "stdout": pulled.stdout.strip(),
        "stderr": pulled.stderr.strip(),
        "exit_code": pulled.returncode,
    })
    write_record(output_path, record)

    if record["status"] != "ok":
        print(record["stderr"] or "git pull --ff-only failed", file=sys.stderr)
        return 1

    json.dump({
        "ok": True,
        "status": "ok",
        "outputs": {"base-sync": "housekeeping/base-sync.json"},
        "before_commit": record["before_commit"],
        "after_commit": record["after_commit"],
        "updated": record["updated"],
    }, sys.stdout)
    print()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
