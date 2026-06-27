#!/usr/bin/env python3
import json
import pathlib
import subprocess
import sys


def truthy(value):
    return str(value).lower() in {"1", "true", "yes", "on"}


def main():
    request = json.load(sys.stdin)
    inputs = request.get("inputs", {})
    run_dir = pathlib.Path(request["paths"]["run_dir"])
    meta = json.loads((run_dir / "conflict-repair" / "worktree.json").read_text())
    worktree = pathlib.Path(meta["worktree"])
    push_refspec = meta["push_refspec"]
    out_dir = run_dir / "conflict-repair"
    dry_run = truthy(inputs.get("dry-run", "true"))
    push_log = out_dir / "push-summary.md"

    if dry_run:
        push_log.write_text(f"# Conflict repair push\n\nSkipped: dry-run is true\n\nWould run:\n\n```bash\ngit push --force-with-lease origin {push_refspec}\n```\n")
        json.dump({"ok": True, "status": "skipped", "reason": "dry-run is true", "outputs": {"summary": "conflict-repair/push-summary.md"}}, sys.stdout)
        print(); return

    result = subprocess.run(["git", "push", "--force-with-lease", "origin", push_refspec], cwd=worktree, text=True, capture_output=True)
    push_log.write_text(
        "# Conflict repair push\n\n"
        f"Command: `git push --force-with-lease origin {push_refspec}`\n\n"
        f"Exit code: {result.returncode}\n\n"
        "## stdout\n\n```text\n" + result.stdout + "\n```\n\n"
        "## stderr\n\n```text\n" + result.stderr + "\n```\n"
    )
    json.dump({"ok": True, "status": "pass" if result.returncode == 0 else "fail", "outputs": {"summary": "conflict-repair/push-summary.md"}}, sys.stdout)
    print()


if __name__ == "__main__":
    main()
