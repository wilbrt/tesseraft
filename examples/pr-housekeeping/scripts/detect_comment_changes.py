#!/usr/bin/env python3
import json
import pathlib
import subprocess
import sys


def main():
    request = json.load(sys.stdin)
    run_dir = pathlib.Path(request["paths"]["run_dir"])
    meta = json.loads((run_dir / "comment-repair" / "worktree.json").read_text())
    worktree = pathlib.Path(meta["worktree"])
    result = subprocess.run(["git", "status", "--porcelain"], cwd=worktree, text=True, capture_output=True, check=True)
    changed = bool(result.stdout.strip())
    out_dir = run_dir / "comment-repair"
    summary = out_dir / "change-summary.md"
    summary.write_text("# Comment repair changes\n\n" + ("Changes detected.\n\n" if changed else "No code changes detected.\n\n") + "```text\n" + result.stdout + "\n```\n")
    json.dump({"ok": True, "status": "changed" if changed else "unchanged", "changed": changed, "outputs": {"summary": "comment-repair/change-summary.md"}}, sys.stdout)
    print()


if __name__ == "__main__":
    main()
