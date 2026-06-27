#!/usr/bin/env python3
import json
import pathlib
import subprocess
import sys


def main():
    request = json.load(sys.stdin)
    inputs = request.get("inputs", {})
    run_dir = pathlib.Path(request["paths"]["run_dir"])
    meta = json.loads((run_dir / "conflict-repair" / "worktree.json").read_text())
    worktree = pathlib.Path(meta["worktree"])
    command = inputs.get("test-command") or "bb test"

    result = subprocess.run(["bash", "-lc", command], cwd=worktree, text=True, capture_output=True)
    out_dir = run_dir / "conflict-repair"
    summary = out_dir / "test-summary.md"
    summary.write_text(
        "# Conflict repair tests\n\n"
        f"Command: `{command}`\n\n"
        f"Exit code: {result.returncode}\n\n"
        "## stdout\n\n```text\n" + result.stdout + "\n```\n\n"
        "## stderr\n\n```text\n" + result.stderr + "\n```\n"
    )
    status = "pass" if result.returncode == 0 else "fail"
    json.dump({"ok": True, "status": status, "outputs": {"summary": "conflict-repair/test-summary.md"}}, sys.stdout)
    print()


if __name__ == "__main__":
    main()
