#!/usr/bin/env python3
import json
import pathlib
import sys
from datetime import datetime, timezone


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


def all_reviews(pr):
    reviews = []
    seen = set()
    for review in (pr.get("latestReviews") or []) + (pr.get("reviews") or []):
        if not isinstance(review, dict):
            continue
        review_id = review.get("id") or (review.get("author", {}).get("login"), review.get("submittedAt"), review.get("state"))
        if review_id in seen:
            continue
        seen.add(review_id)
        reviews.append(review)
    return reviews


def comment_count(pr):
    top_level_comments = len(pr.get("comments") or [])
    review_comments = sum(1 for review in all_reviews(pr) if review.get("state") == "COMMENTED")
    return top_level_comments + review_comments


def latest_review_state(pr):
    reviews = all_reviews(pr)
    states = [r.get("state") for r in reviews]
    if "CHANGES_REQUESTED" in states:
        return "CHANGES_REQUESTED"
    if "APPROVED" in states:
        return "APPROVED"
    return pr.get("reviewDecision") or "REVIEW_REQUIRED"


REBASE_AGE_THRESHOLD_DAYS = 5


def parse_updated_at(pr):
    raw = pr.get("updatedAt")
    if not raw:
        return None
    try:
        return datetime.fromisoformat(str(raw).replace("Z", "+00:00"))
    except ValueError:
        return None


def age_days(pr, snapshot_at):
    updated = parse_updated_at(pr)
    if not updated or snapshot_at is None:
        return None
    delta = snapshot_at - updated
    return max(delta.total_seconds(), 0) / 86400.0


def rebase_recommended(pr, age, merge_state):
    # Strict, read-only signal: only an explicit BEHIND merge state combined
    # with age >= threshold triggers a rebase recommendation. Never fire on
    # UNKNOWN or missing data (see docs/MERGE_PROTOCOL.md).
    if age is None:
        return False
    return age >= REBASE_AGE_THRESHOLD_DAYS and merge_state == "BEHIND"


def classify(pr, merge_approved=False, snapshot_at=None):
    merge_state = pr.get("mergeStateStatus") or "UNKNOWN"
    review = latest_review_state(pr)
    draft = bool(pr.get("isDraft"))
    checks = checks_status(pr)
    comments = comment_count(pr)
    age = age_days(pr, snapshot_at)
    rebase_flag = rebase_recommended(pr, age, merge_state)

    if draft:
        action = "skip"
        reason = "draft PR"
    elif merge_state == "DIRTY":
        action = "fix-conflicts"
        reason = "merge conflicts detected"
    elif review == "CHANGES_REQUESTED":
        action = "fix-comments"
        reason = "changes requested by review"
    elif comments:
        action = "respond-only"
        reason = f"{comments} comment/review comment signal(s) need a response"
    elif checks == "failing" and merge_state in {"MERGEABLE", "UNSTABLE", "BEHIND", "CLEAN"}:
        action = "fix-tests"
        reason = "CI checks failing but mergeable; rebase onto base and push to refresh CI"
    elif merge_state == "UNKNOWN" and checks in {"failing", "none"}:
        action = "fix-tests"
        reason = "merge state stale; rebase to refresh mergeability and rerun CI"
    elif merge_state == "UNKNOWN":
        action = "blocked"
        reason = "merge state is UNKNOWN"
    elif rebase_flag:
        action = "recommend-rebase"
        reason = (
            f"PR is {age:.1f} days old (updatedAt={pr.get('updatedAt')}) "
            "and BEHIND base; rebase recommended"
        )
    elif review == "APPROVED" and checks in {"success", "none"}:
        action = "merge" if merge_approved else "ready-to-merge"
        reason = "approved and mergeable" if merge_approved else "approved and mergeable; merge disabled"
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
        "needs_response": review == "CHANGES_REQUESTED" or comments > 0,
        "age_days": round(age, 1) if age is not None else None,
        "rebase_recommended": rebase_flag,
        "snapshot_at": snapshot_at.isoformat() if snapshot_at else None,
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
    snapshot_at = datetime.now(timezone.utc)
    actions = [classify(pr, merge_approved=merge_approved, snapshot_at=snapshot_at) for pr in prs]

    out_dir = run_dir / "housekeeping"
    actions_path = out_dir / "actions.json"
    report_path = out_dir / "report.md"
    actions_path.write_text(json.dumps(actions, indent=2) + "\n")

    lines = ["# PR Housekeeping Report", "", f"Open PRs inspected: {len(actions)}", ""]
    if not actions:
        lines.append("No open PRs found.")
    else:
        lines.extend(["| PR | Action | Review | Merge state | Checks | Comments | Age (d) | Reason |", "|---:|---|---|---|---|---:|---:|---|"])
        for item in actions:
            age_str = f"{item['age_days']:.1f}" if item.get("age_days") is not None else "?"
            lines.append(
                f"| [#{item['number']}]({item['url']}) | {item['action']} | {item['review_decision']} | {item['merge_state']} | {item['checks_status']} | {item['comment_count']} | {age_str} | {item['reason']} |"
            )
    rebase_count = sum(1 for item in actions if item.get("rebase_recommended"))
    lines.append("")
    lines.append(
        f"Rebase recommendations: {rebase_count} PR(s) older than "
        f"{REBASE_AGE_THRESHOLD_DAYS} days and BEHIND base."
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
