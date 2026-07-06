#!/usr/bin/env python3
import json
import pathlib
import sys

ACTION_FILES = {
    "fix-conflicts": "conflict-prs.json",
    "fix-tests": "test-prs.json",
    "fix-comments": "comment-prs.json",
    "respond-only": "response-prs.json",
    "ready-to-merge": "merge-ready-prs.json",
    "merge": "merge-prs.json",
    "skip": "skipped-prs.json",
    "blocked": "blocked-prs.json",
    "recommend-rebase": "rebase-recommendations.json",
}


def main():
    request = json.load(sys.stdin)
    run_dir = pathlib.Path(request["paths"]["run_dir"])
    dry_run = str(request.get("inputs", {}).get("dry-run", "false")).lower() == "true"
    actions_path = run_dir / "housekeeping" / "actions.json"
    actions = json.loads(actions_path.read_text())

    groups = {action: [] for action in ACTION_FILES}
    for item in actions:
        groups.setdefault(item.get("action", "blocked"), []).append(item)
    groups["respond-only"] = [item for item in actions if item.get("needs_response")]
    # The rebase recommendation is a parallel, report-only signal: list every
    # PR flagged `rebase_recommended` regardless of its primary action, so the
    # rebase report is a complete view of stale-and-behind PRs (see
    # docs/MERGE_PROTOCOL.md). These items are never selected for repair by
    # select_conflict_target.py / select_comment_target.py.
    groups["recommend-rebase"] = [item for item in actions if item.get("rebase_recommended")]

    out_dir = run_dir / "housekeeping" / "planned"
    out_dir.mkdir(parents=True, exist_ok=True)
    outputs = {}
    for action, filename in ACTION_FILES.items():
        path = out_dir / filename
        path.write_text(json.dumps(groups.get(action, []), indent=2) + "\n")
        outputs[action] = f"housekeeping/planned/{filename}"

    lines = ["# PR Housekeeping Action Plan", "", f"Dry run: {dry_run}", ""]
    for action in ACTION_FILES:
        items = groups.get(action, [])
        title = "response-needed" if action == "respond-only" else action
        lines.append(f"## {title} ({len(items)})")
        lines.append("")
        if not items:
            lines.append("None.")
        else:
            for item in items:
                lines.append(f"- #{item['number']} {item['title']} — {item['reason']}")
        lines.append("")
    plan_path = run_dir / "housekeeping" / "action-plan.md"
    plan_path.write_text("\n".join(lines))

    json.dump({
        "ok": True,
        "status": "ok",
        "outputs": {"plan": "housekeeping/action-plan.md", **outputs}
    }, sys.stdout)
    print()


if __name__ == "__main__":
    main()
