#!/usr/bin/env python3
import json
import pathlib
import subprocess
import sys


def main():
    request = json.load(sys.stdin)
    inputs = request.get("inputs", {})
    run_dir = pathlib.Path(request["paths"]["run_dir"])
    meta = json.loads((run_dir / "comment-repair" / "worktree.json").read_text())
    worktree = pathlib.Path(meta["worktree"])
    # Mirror the GitHub Actions CI job (`.github/workflows/ci.yml`) so this
    # step reproduces real CI failures (e.g. TS2688 from a missing `npm ci`),
    # not just `bb test` which false-greens when local node_modules has
    # @types/node installed. Override per-run via the `test-command` input.
    command = inputs.get("test-command") or "npm ci && bb test && npm run web:test"
    result = subprocess.run(["bash", "-lc", command], cwd=worktree, text=True, capture_output=True)
    summary = run_dir / "comment-repair" / "test-summary.md"
    summary.write_text(
        "# Comment repair tests\n\n"
        f"Command: `{command}`\n\n"
        f"Exit code: {result.returncode}\n\n"
        "## stdout\n\n```text\n" + result.stdout + "\n```\n\n"
        "## stderr\n\n```text\n" + result.stderr + "\n```\n"
    )
    json.dump({"ok": True, "status": "pass" if result.returncode == 0 else "fail", "outputs": {"summary": "comment-repair/test-summary.md"}}, sys.stdout)
    print()


if __name__ == "__main__":
    main()
