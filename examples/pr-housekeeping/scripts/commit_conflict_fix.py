#!/usr/bin/env python3
import json
import pathlib
import subprocess
import sys


def run(cmd, cwd, check=False):
    return subprocess.run(cmd, cwd=cwd, text=True, capture_output=True, check=check)


def main():
    request = json.load(sys.stdin)
    run_dir = pathlib.Path(request["paths"]["run_dir"])
    meta = json.loads((run_dir / "conflict-repair" / "worktree.json").read_text())
    worktree = pathlib.Path(meta["worktree"])
    target = meta["target_pr"]
    out_dir = run_dir / "conflict-repair"
    summary = out_dir / "commit-summary.md"

    status = run(["git", "status", "--porcelain"], cwd=worktree, check=True).stdout
    if not status.strip():
        summary.write_text("# Conflict repair commit\n\nNo changes to commit.\n")
        json.dump({"ok": True, "status": "skipped", "reason": "no changes", "outputs": {"summary": "conflict-repair/commit-summary.md"}}, sys.stdout)
        print(); return

    run(["git", "add", "-A"], cwd=worktree, check=True)
    result = run(["git", "commit", "-m", f"Resolve PR #{target} conflicts"], cwd=worktree)
    summary.write_text(
        "# Conflict repair commit\n\n"
        f"Exit code: {result.returncode}\n\n"
        "## stdout\n\n```text\n" + result.stdout + "\n```\n\n"
        "## stderr\n\n```text\n" + result.stderr + "\n```\n"
    )
    json.dump({"ok": True, "status": "pass" if result.returncode == 0 else "fail", "outputs": {"summary": "conflict-repair/commit-summary.md"}}, sys.stdout)
    print()


if __name__ == "__main__":
    main()
