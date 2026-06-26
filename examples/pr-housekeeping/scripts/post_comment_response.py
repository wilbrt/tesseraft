#!/usr/bin/env python3
import json
import pathlib
import re
import subprocess
import sys


def truthy(value):
    return str(value).lower() in {"1", "true", "yes", "on"}


def clean_draft(text):
    lines = text.splitlines()
    cleaned = []
    skip_quote_block = False
    for line in lines:
        stripped = line.strip()
        lower = stripped.lower().rstrip(":")
        if lower in {"# draft responses", "draft responses", "draft response", "# draft response"}:
            continue
        if re.match(r"^#{1,6}\s*review comment", stripped, re.I):
            continue
        if lower == "draft response":
            continue
        if stripped.startswith(">"):
            continue
        if stripped.startswith("## ") and "review comment" in stripped.lower():
            continue
        cleaned.append(line)
    body = "\n".join(cleaned).strip()
    body = re.sub(r"\n{3,}", "\n\n", body)
    return body or text.strip()


def main():
    request = json.load(sys.stdin)
    inputs = request.get("inputs", {})
    run_dir = pathlib.Path(request["paths"]["run_dir"])
    meta = json.loads((run_dir / "comment-repair" / "worktree.json").read_text())
    target = meta["target_pr"]
    round_id = request["run"]["round"]
    post_path = run_dir / "comment-repair" / f"response-post-{round_id}.md"
    draft_path = run_dir / "comment-repair" / f"response-draft-{round_id}.md"
    body_path = run_dir / "comment-repair" / f"response-body-{round_id}.md"
    out_dir = run_dir / "comment-repair"
    summary = out_dir / "post-summary.md"

    source_path = post_path if post_path.exists() else draft_path
    if not source_path.exists():
        summary.write_text(f"# Post comment response\n\nSkipped: response body missing at `{post_path}` and `{draft_path}`.\n")
        json.dump({"ok": True, "status": "skipped", "reason": "response body missing", "outputs": {"summary": "comment-repair/post-summary.md"}}, sys.stdout)
        print(); return

    body = source_path.read_text().strip() if source_path == post_path else clean_draft(source_path.read_text())
    body_path.write_text(body + "\n")

    dry_run = truthy(inputs.get("dry-run", "true"))
    post_enabled = truthy(inputs.get("post-comment-responses", "false"))

    if dry_run or not post_enabled:
        reason = "dry-run is true" if dry_run else "post-comment-responses is false"
        summary.write_text(
            "# Post comment response\n\n"
            f"Skipped: {reason}\n\n"
            f"Prepared body: `{body_path}`\n\n"
            f"Would run:\n\n```bash\ngh pr comment {target} --body-file {body_path}\n```\n"
        )
        json.dump({"ok": True, "status": "skipped", "reason": reason, "outputs": {"summary": "comment-repair/post-summary.md", "body": f"comment-repair/response-body-{round_id}.md"}}, sys.stdout)
        print(); return

    result = subprocess.run(["gh", "pr", "comment", str(target), "--body-file", str(body_path)], text=True, capture_output=True)
    summary.write_text(
        "# Post comment response\n\n"
        f"Prepared body: `{body_path}`\n\n"
        f"Command: `gh pr comment {target} --body-file {body_path}`\n\n"
        f"Exit code: {result.returncode}\n\n"
        "## stdout\n\n```text\n" + result.stdout + "\n```\n\n"
        "## stderr\n\n```text\n" + result.stderr + "\n```\n"
    )
    json.dump({"ok": True, "status": "pass" if result.returncode == 0 else "fail", "outputs": {"summary": "comment-repair/post-summary.md", "body": f"comment-repair/response-body-{round_id}.md"}}, sys.stdout)
    print()


if __name__ == "__main__":
    main()
