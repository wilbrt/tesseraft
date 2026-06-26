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
    meta = json.loads((run_dir / "comment-repair" / "worktree.json").read_text())
    target = meta["target_pr"]
    response_path = run_dir / "comment-repair" / f"response-draft-{request['run']['round']}.md"
    out_dir = run_dir / "comment-repair"
    summary = out_dir / "post-summary.md"

    dry_run = truthy(inputs.get("dry-run", "true"))
    post_enabled = truthy(inputs.get("post-comment-responses", "false"))

    if not response_path.exists():
        summary.write_text(f"# Post comment response\n\nSkipped: response draft missing at `{response_path}`.\n")
        json.dump({"ok": True, "status": "skipped", "reason": "response draft missing", "outputs": {"summary": "comment-repair/post-summary.md"}}, sys.stdout)
        print(); return

    if dry_run or not post_enabled:
        reason = "dry-run is true" if dry_run else "post-comment-responses is false"
        summary.write_text(
            "# Post comment response\n\n"
            f"Skipped: {reason}\n\n"
            f"Would run:\n\n```bash\ngh pr comment {target} --body-file {response_path}\n```\n"
        )
        json.dump({"ok": True, "status": "skipped", "reason": reason, "outputs": {"summary": "comment-repair/post-summary.md"}}, sys.stdout)
        print(); return

    result = subprocess.run(["gh", "pr", "comment", str(target), "--body-file", str(response_path)], text=True, capture_output=True)
    summary.write_text(
        "# Post comment response\n\n"
        f"Command: `gh pr comment {target} --body-file {response_path}`\n\n"
        f"Exit code: {result.returncode}\n\n"
        "## stdout\n\n```text\n" + result.stdout + "\n```\n\n"
        "## stderr\n\n```text\n" + result.stderr + "\n```\n"
    )
    json.dump({"ok": True, "status": "pass" if result.returncode == 0 else "fail", "outputs": {"summary": "comment-repair/post-summary.md"}}, sys.stdout)
    print()


if __name__ == "__main__":
    main()
