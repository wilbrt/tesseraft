#!/usr/bin/env python3
import json
import pathlib
import sys


def checks_status(pr):
    checks = pr.get("statusCheckRollup") or []
    if not checks:
        return "none"
    conclusions = []
    statuses = []
    for check in checks:
        if isinstance(check, dict):
            conclusions.append(check.get("conclusion"))
            statuses.append(check.get("status"))
    if any(s not in (None, "COMPLETED") for s in statuses):
        return "pending"
    if any(c not in (None, "SUCCESS", "SKIPPED", "NEUTRAL") for c in conclusions):
        return "failing"
    return "success"


def comment_count(pr):
    return len(pr.get("comments") or [])


def latest_review_state(pr):
    reviews = (pr.get("latestReviews") or []) + (pr.get("reviews") or [])
    states = [r.get("state") for r in reviews if isinstance(r, dict)]
    if "CHANGES_REQUESTED" in states:
        return "CHANGES_REQUESTED"
    if "APPROVED" in states:
        return "APPROVED"
    return pr.get("reviewDecision") or "REVIEW_REQUIRED"


def classify(pr, merge_approved=False):
    merge_state = pr.get("mergeStateStatus") or "UNKNOWN"
    review = latest_review_state(pr)
    draft = bool(pr.get("isDraft"))
    checks = checks_status(pr)
    comments = comment_count(pr)

    if draft:
        action = "skip"
        reason = "draft PR"
    elif merge_state == "DIRTY":
        action = "fix-conflicts"
        reason = "merge conflicts detected"
    elif review == "CHANGES_REQUESTED":
        action = "fix-comments"
        reason = "changes requested by review"
    elif merge_state == "UNKNOWN":
        action = "blocked"
        reason = "merge state is UNKNOWN"
    elif review == "APPROVED" and checks in {"success", "none"}:
        action = "merge" if merge_approved else "ready-to-merge"
        reason = "approved and mergeable" if merge_approved else "approved and mergeable; merge disabled"
    elif comments:
        action = "respond-only"
        reason = f"{comments} comment(s) with no unresolved review thread detected"
    elif checks == "failing":
        action = "blocked"
        reason = "checks failing"
    elif checks == "pending":
        action = "skip"
        reason = "checks pending"
    else:
        action = "skip"
        reason = f"review decision is {review}"

    return {
        "number": pr.get("number"),
        "title": pr.get("title"),
        "url": pr.get("url"),
        "head": pr.get("headRefName"),
        "base": pr.get("baseRefName"),
        "review_decision": review,
        "merge_state": merge_state,
        "checks_status": checks,
        "is_draft": draft,
        "comment_count": comments,
        "action": action,
        "reason": reason,
    }


def main():
    request = json.load(sys.stdin)
    run_dir = pathlib.Path(request["paths"]["run_dir"])
    inputs = request.get("inputs", {})
    merge_approved = str(inputs.get("merge-approved", "false")).lower() == "true"

    states_path = run_dir / "housekeeping" / "pr-states.json"
    open_prs_path = run_dir / "housekeeping" / "open-prs.json"
    if states_path.exists():
        prs = json.loads(states_path.read_text())
    else:
        prs = json.loads(open_prs_path.read_text())
    actions = [classify(pr, merge_approved=merge_approved) for pr in prs]

    out_dir = run_dir / "housekeeping"
    actions_path = out_dir / "actions.json"
    report_path = out_dir / "report.md"
    actions_path.write_text(json.dumps(actions, indent=2) + "\n")

    lines = ["# PR Housekeeping Report", "", f"Open PRs inspected: {len(actions)}", ""]
    if not actions:
        lines.append("No open PRs found.")
    else:
        lines.extend(["| PR | Action | Review | Merge state | Checks | Comments | Reason |", "|---:|---|---|---|---|---:|---|"])
        for item in actions:
            lines.append(
                f"| [#{item['number']}]({item['url']}) | {item['action']} | {item['review_decision']} | {item['merge_state']} | {item['checks_status']} | {item['comment_count']} | {item['reason']} |"
            )
    report_path.write_text("\n".join(lines) + "\n")

    json.dump({
        "ok": True,
        "status": "ok",
        "outputs": {
            "actions": "housekeeping/actions.json",
            "report": "housekeeping/report.md"
        }
    }, sys.stdout)
    print()


if __name__ == "__main__":
    main()
