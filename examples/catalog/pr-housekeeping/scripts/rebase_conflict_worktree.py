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
    base = meta["base_ref"]

    run(["git", "fetch", "origin", base], cwd=worktree, check=True)
    result = run(["git", "rebase", f"origin/{base}"], cwd=worktree)

    out_dir = run_dir / "conflict-repair"
    summary = out_dir / "rebase-summary.md"
    summary.write_text(
        "# Conflict repair rebase\n\n"
        f"Command: `git rebase origin/{base}`\n\n"
        f"Exit code: {result.returncode}\n\n"
        "## stdout\n\n```text\n" + result.stdout + "\n```\n\n"
        "## stderr\n\n```text\n" + result.stderr + "\n```\n"
    )

    status = "pass" if result.returncode == 0 else "needs-fix"
    json.dump({"ok": True, "status": status, "outputs": {"summary": "conflict-repair/rebase-summary.md"}}, sys.stdout)
    print()


if __name__ == "__main__":
    main()
