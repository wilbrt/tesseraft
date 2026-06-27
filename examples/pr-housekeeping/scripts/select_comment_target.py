#!/usr/bin/env python3
import json
import pathlib
import subprocess
import sys

from path_utils import resolve_repo_root
from response_tracking import pending_sources


def run(cmd, cwd, check=True):
    return subprocess.run(cmd, cwd=cwd, text=True, capture_output=True, check=check).stdout


def gh_api_all(repo_root, endpoint):
    raw = run(["gh", "api", "--paginate", "--slurp", endpoint], cwd=repo_root)
    pages = json.loads(raw)
    items = []
    for page in pages:
        items.extend(page if isinstance(page, list) else [page])
    return items


def pending_for_pr(repo_root, repo, number):
    feedback = {
        "issue_comments": gh_api_all(repo_root, f"repos/{repo}/issues/{number}/comments?per_page=100"),
        "review_comments": gh_api_all(repo_root, f"repos/{repo}/pulls/{number}/comments?per_page=100"),
    }
    return pending_sources(feedback)


def main():
    request = json.load(sys.stdin)
    inputs = request.get("inputs", {})
    run_dir = pathlib.Path(request["paths"]["run_dir"])
    repo_root = resolve_repo_root(request)
    repo = run(["gh", "repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"], cwd=repo_root).strip()
    out_dir = run_dir / "comment-repair"
    out_dir.mkdir(parents=True, exist_ok=True)

    actions = json.loads((run_dir / "housekeeping" / "actions.json").read_text())
    processed_path = run_dir / "housekeeping" / "processed-prs.json"
    processed = json.loads(processed_path.read_text()) if processed_path.exists() else {"conflict": [], "comment": []}
    processed_comments = {int(v) for v in processed.get("comment", [])}
    target = inputs.get("target-pr")
    candidates = [item for item in actions if item.get("needs_response") and int(item.get("number")) not in processed_comments]
    if target:
        target_num = int(target)
        candidates = [item for item in candidates if int(item.get("number")) == target_num]

    skipped = []
    for item in candidates:
        number = int(item["number"])
        pending = pending_for_pr(repo_root, repo, number)
        if pending:
            selection = {"selected": True, "pr": item, "auto_selected": not bool(target), "pending_sources": pending}
            (out_dir / "selection.json").write_text(json.dumps(selection, indent=2) + "\n")
            (out_dir / "target-pr.txt").write_text(str(number) + "\n")
            (out_dir / "pending-sources.json").write_text(json.dumps(pending, indent=2) + "\n")
            json.dump({"ok": True, "status": "pass", "outputs": {"selection": "comment-repair/selection.json", "target-pr": "comment-repair/target-pr.txt", "pending-sources": "comment-repair/pending-sources.json"}}, sys.stdout)
            print(); return
        skipped.append(number)
        processed_comments.add(number)

    if skipped:
        processed["comment"] = sorted(processed_comments)
        processed_path.write_text(json.dumps(processed, indent=2) + "\n")

    reason = "no PR target with unreplied comments or requested changes" if not target else f"PR #{target} has no unreplied comments or requested changes"
    (out_dir / "selection.json").write_text(json.dumps({"selected": False, "reason": reason, "already_replied": skipped}, indent=2) + "\n")
    json.dump({"ok": True, "status": "skip", "reason": reason, "outputs": {"selection": "comment-repair/selection.json"}}, sys.stdout)
    print()


if __name__ == "__main__":
    main()
