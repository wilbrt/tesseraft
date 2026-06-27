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
    original = meta.get("original_head_oid")
    out_dir = run_dir / "conflict-repair"
    summary = out_dir / "commit-summary.md"

    status = run(["git", "status", "--porcelain"], cwd=worktree, check=True).stdout
    current = run(["git", "rev-parse", "HEAD"], cwd=worktree, check=True).stdout.strip()

    if status.strip():
        run(["git", "add", "-A"], cwd=worktree, check=True)
        result = run(["git", "commit", "-m", f"Resolve PR #{target} conflicts"], cwd=worktree)
        current_after = run(["git", "rev-parse", "HEAD"], cwd=worktree, check=True).stdout.strip() if result.returncode == 0 else current
        summary.write_text(
            "# Conflict repair pre-push commit\n\n"
            "Uncommitted changes were present after conflict repair, so the workflow committed them before push.\n\n"
            f"Original PR head: `{original or 'unknown'}`\n\n"
            f"Current head: `{current_after}`\n\n"
            f"Exit code: {result.returncode}\n\n"
            "## stdout\n\n```text\n" + result.stdout + "\n```\n\n"
            "## stderr\n\n```text\n" + result.stderr + "\n```\n"
        )
        json.dump({"ok": True, "status": "pass" if result.returncode == 0 else "fail", "outputs": {"summary": "conflict-repair/commit-summary.md"}}, sys.stdout)
        print(); return

    if original and current != original:
        summary.write_text(
            "# Conflict repair pre-push verification\n\n"
            "No uncommitted changes remain. The rebase rewrote the PR history, so the current HEAD differs from the original PR head and is ready for the gated force-with-lease push.\n\n"
            f"Original PR head: `{original}`\n\n"
            f"Current head: `{current}`\n"
        )
        json.dump({"ok": True, "status": "pass", "outputs": {"summary": "conflict-repair/commit-summary.md"}}, sys.stdout)
        print(); return

    summary.write_text(
        "# Conflict repair pre-push verification\n\n"
        "No uncommitted changes remain, and the current HEAD matches the original PR head. Nothing needs to be pushed.\n\n"
        f"Original PR head: `{original or 'unknown'}`\n\n"
        f"Current head: `{current}`\n"
    )
    json.dump({"ok": True, "status": "skipped", "reason": "no rebase changes", "outputs": {"summary": "conflict-repair/commit-summary.md"}}, sys.stdout)
    print()


if __name__ == "__main__":
    main()
