#!/usr/bin/env python3
import json
import pathlib
import re
import sys

REQUIRED_HEADINGS = [
    "Title", "Description", "Problem", "Evidence", "Use cases",
    "Approaches and criteria", "Decision and tradeoffs", "Scope",
    "Implementation plan", "Validation", "Risks and unknowns",
]
BRANCH_RE = re.compile(r"^(feature|fix|docs|refactor|test|chore)/[a-z0-9][a-z0-9/-]*$")
ALLOWED_TIERS = ["focused", "repository", "browser"]


def validate_plan(plan: object) -> list[str]:
    errors: list[str] = []
    if not isinstance(plan, dict) or plan.get("version") != 1:
        return ["validation plan requires object version 1"]
    tiers = plan.get("tiers")
    if not isinstance(tiers, list) or not 1 <= len(tiers) <= 3:
        return ["validation plan requires one to three tiers"]
    seen_tiers: list[str] = []
    seen_checks: set[str] = set()
    for tier in tiers:
        if not isinstance(tier, dict) or set(tier) != {"id", "checks"}:
            errors.append("each tier requires only id and checks")
            continue
        tier_id = tier.get("id")
        if tier_id not in ALLOWED_TIERS or tier_id in seen_tiers:
            errors.append(f"invalid or duplicate tier: {tier_id}")
        else:
            seen_tiers.append(tier_id)
        checks = tier.get("checks")
        if not isinstance(checks, list) or not 1 <= len(checks) <= 8:
            errors.append(f"tier {tier_id} requires one to eight checks")
            continue
        for check in checks:
            if not isinstance(check, dict) or set(check) != {"id", "command", "timeout_seconds"}:
                errors.append(f"tier {tier_id} has malformed check")
                continue
            check_id = check.get("id")
            command = check.get("command")
            timeout = check.get("timeout_seconds")
            if not isinstance(check_id, str) or not check_id or check_id in seen_checks:
                errors.append(f"invalid or duplicate check id: {check_id}")
            else:
                seen_checks.add(check_id)
            if not isinstance(command, list) or not command or not all(isinstance(x, str) and x for x in command):
                errors.append(f"check {check_id} command must be a non-empty argv array")
            if not isinstance(timeout, int) or isinstance(timeout, bool) or not 1 <= timeout <= 3600:
                errors.append(f"check {check_id} timeout must be 1..3600 seconds")
    expected_order = sorted(seen_tiers, key=ALLOWED_TIERS.index)
    if seen_tiers != expected_order:
        errors.append("tiers must be ordered focused, repository, browser")
    return errors


def main() -> None:
    request = json.load(sys.stdin)
    run_dir = pathlib.Path(request["paths"]["run_dir"]).resolve()
    brief_path = run_dir / "design/brief.md"
    plan_path = run_dir / "design/validation-plan.json"
    branch_path = run_dir / "design/branch-name.txt"
    title_path = run_dir / "design/pr-title.txt"
    errors: list[str] = []
    brief = brief_path.read_text() if brief_path.exists() else ""
    if not brief:
        errors.append("design/brief.md is missing or empty")
    elif len(brief.encode()) > 8192:
        errors.append("design/brief.md exceeds 8192 bytes")
    for heading in REQUIRED_HEADINGS:
        if not re.search(rf"^#+\s+{re.escape(heading)}\s*$", brief, re.MULTILINE | re.IGNORECASE):
            errors.append(f"design brief missing heading: {heading}")
    try:
        plan = json.loads(plan_path.read_text())
        errors.extend(validate_plan(plan))
    except Exception as exc:
        errors.append(f"validation plan is unreadable: {exc}")
    branch = branch_path.read_text().strip() if branch_path.exists() else ""
    if not BRANCH_RE.fullmatch(branch) or ".." in branch or "//" in branch:
        errors.append("branch name is missing or unsafe")
    title = title_path.read_text().strip() if title_path.exists() else ""
    if not title or len(title) > 100 or "\n" in title:
        errors.append("PR title must be one non-empty line of at most 100 characters")
    report = {"version": 1, "status": "fail" if errors else "pass", "errors": errors}
    out = run_dir / "design/check-current.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n")
    json.dump({"ok": True, "status": report["status"], "summary": "design contract valid" if not errors else "design contract needs correction", "outputs": {"report": "design/check-current.json"}}, sys.stdout)
    print()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"design check error: {exc}", file=sys.stderr)
        raise SystemExit(2)
