#!/usr/bin/env python3
import json
import pathlib
import subprocess
import sys


def run(cmd, cwd, check=True):
    return subprocess.run(cmd, cwd=cwd, text=True, capture_output=True, check=check).stdout


def gh_api_all(repo_root, endpoint):
    raw = run(["gh", "api", "--paginate", "--slurp", endpoint], cwd=repo_root)
    pages = json.loads(raw)
    items = []
    for page in pages:
        if isinstance(page, list):
            items.extend(page)
        else:
            items.append(page)
    return items


def main():
    request = json.load(sys.stdin)
    repo_root = pathlib.Path(request["paths"]["repo_root"]).resolve()
    run_dir = pathlib.Path(request["paths"]["run_dir"])
    meta = json.loads((run_dir / "comment-repair" / "worktree.json").read_text())
    target = meta["target_pr"]
    repo = run(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd=repo_root).strip()

    pr = json.loads(run(["gh", "pr", "view", str(target), "--json", "number,url,title,body,state,comments,reviews,latestReviews,reviewDecision,statusCheckRollup,mergeStateStatus"], cwd=repo_root))
    feedback = {
        "pr": pr,
        "issue_comments": gh_api_all(repo_root, f"repos/{repo}/issues/{target}/comments?per_page=100"),
        "reviews": gh_api_all(repo_root, f"repos/{repo}/pulls/{target}/reviews?per_page=100"),
        "review_comments": gh_api_all(repo_root, f"repos/{repo}/pulls/{target}/comments?per_page=100"),
    }

    out_dir = run_dir / "comment-repair"
    feedback_path = out_dir / "feedback.json"
    feedback_path.write_text(json.dumps(feedback, indent=2) + "\n")

    summary = ["# PR Comment Feedback", "", f"PR: #{target} {pr.get('title')}", ""]
    summary.append(f"Issue comments: {len(feedback['issue_comments'])}")
    summary.append(f"Reviews: {len(feedback['reviews'])}")
    summary.append(f"Review comments: {len(feedback['review_comments'])}")
    summary.append("")
    for label, items in [("Issue comments", feedback["issue_comments"]), ("Reviews", feedback["reviews"]), ("Review comments", feedback["review_comments"])]:
        summary.append(f"## {label}")
        summary.append("")
        if not items:
            summary.append("None.")
            summary.append("")
            continue
        for item in items:
            author = (item.get("user") or item.get("author") or {}).get("login")
            body = item.get("body") or ""
            state = item.get("state") or ""
            path = item.get("path") or ""
            line = item.get("line") or item.get("original_line") or ""
            summary.append(f"- {author or 'unknown'} {state} {path}:{line}")
            if body:
                summary.append("\n```text")
                summary.append(body[:2000])
                summary.append("```")
            summary.append("")
    summary_path = out_dir / "feedback-summary.md"
    summary_path.write_text("\n".join(summary))

    json.dump({"ok": True, "status": "pass", "outputs": {"feedback": "comment-repair/feedback.json", "summary": "comment-repair/feedback-summary.md"}}, sys.stdout)
    print()


if __name__ == "__main__":
    main()
