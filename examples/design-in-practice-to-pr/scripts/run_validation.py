#!/usr/bin/env python3
"""Run schema-checked deterministic validation tiers, stopping at first failure.

Expected command failures return process status=fail with exit 0. Malformed
requests/plans and runner faults exit nonzero.
"""
import hashlib
import json
import pathlib
import shlex
import subprocess
import sys
from typing import Any

MAX_CAPTURE = 50_000
DIAGNOSTIC_TAIL = 1800
SYNC_MARKER = "out of sync with STATUS.edn"
ALLOWED_TIERS = ["focused", "repository", "browser"]


def confined(root: pathlib.Path, relative: str) -> pathlib.Path:
    path = (root / relative).resolve()
    path.relative_to(root.resolve())
    return path


def clipped(value: str | bytes, maximum: int = MAX_CAPTURE) -> str:
    text = value.decode(errors="replace") if isinstance(value, bytes) else value
    return text if len(text) <= maximum else f"[truncated to last {maximum} characters]\n{text[-maximum:]}"


def load_plan(run_dir: pathlib.Path) -> list[tuple[str, dict[str, Any]]]:
    plan = json.loads((run_dir / "design/validation-plan.json").read_text())
    if not isinstance(plan, dict) or plan.get("version") != 1:
        raise ValueError("validation plan requires object version 1")
    tiers = plan.get("tiers")
    if not isinstance(tiers, list) or not 1 <= len(tiers) <= 3:
        raise ValueError("validation plan requires one to three tiers")
    flattened: list[tuple[str, dict[str, Any]]] = []
    seen_tiers: list[str] = []
    seen_checks: set[str] = set()
    for tier in tiers:
        if not isinstance(tier, dict) or set(tier) != {"id", "checks"}:
            raise ValueError("each validation tier requires only id and checks")
        tier_id = tier["id"]
        if tier_id not in ALLOWED_TIERS or tier_id in seen_tiers:
            raise ValueError(f"invalid or duplicate validation tier: {tier_id}")
        seen_tiers.append(tier_id)
        checks = tier["checks"]
        if not isinstance(checks, list) or not 1 <= len(checks) <= 8:
            raise ValueError(f"tier {tier_id} requires one to eight checks")
        for check in checks:
            if not isinstance(check, dict) or set(check) != {"id", "command", "timeout_seconds"}:
                raise ValueError(f"tier {tier_id} has malformed check")
            check_id, command, timeout = check["id"], check["command"], check["timeout_seconds"]
            if not isinstance(check_id, str) or not check_id or check_id in seen_checks:
                raise ValueError(f"invalid or duplicate check id: {check_id}")
            if not isinstance(command, list) or not command or not all(isinstance(x, str) and x for x in command):
                raise ValueError(f"check {check_id} command must be a non-empty argv array")
            if not isinstance(timeout, int) or isinstance(timeout, bool) or not 1 <= timeout <= 3600:
                raise ValueError(f"check {check_id} timeout must be 1..3600 seconds")
            seen_checks.add(check_id)
            flattened.append((tier_id, check))
    if seen_tiers != sorted(seen_tiers, key=ALLOWED_TIERS.index):
        raise ValueError("validation tiers must be ordered focused, repository, browser")
    return flattened


def execute(check: dict[str, Any], worktree: pathlib.Path) -> dict[str, Any]:
    try:
        result = subprocess.run(check["command"], cwd=worktree, text=True, capture_output=True, timeout=check["timeout_seconds"])
        return {"exit_code": result.returncode, "timed_out": False, "stdout": clipped(result.stdout), "stderr": clipped(result.stderr)}
    except subprocess.TimeoutExpired as exc:
        return {"exit_code": None, "timed_out": True, "stdout": clipped(exc.stdout or ""), "stderr": clipped(exc.stderr or "")}
    except FileNotFoundError as exc:
        return {"exit_code": 127, "timed_out": False, "stdout": "", "stderr": str(exc)}


def maybe_self_heal_status(check: dict[str, Any], result: dict[str, Any], worktree: pathlib.Path) -> tuple[dict[str, Any], bool]:
    if check["command"] != ["bb", "test"] or result["timed_out"] or result["exit_code"] in (0, 127):
        return result, False
    if SYNC_MARKER not in f"{result['stdout']}\n{result['stderr']}":
        return result, False
    regenerate = subprocess.run(["bb", "status"], cwd=worktree, text=True, capture_output=True, timeout=120)
    if regenerate.returncode != 0:
        return result, False
    changed = subprocess.run(["git", "status", "--short", "--", "README.md", "STATUS.edn"], cwd=worktree, text=True, capture_output=True)
    if not changed.stdout.strip():
        return result, False
    subprocess.run(["git", "add", "README.md", "STATUS.edn"], cwd=worktree, check=False)
    subprocess.run(["git", "-c", "user.name=tesseraft-bot", "-c", "user.email=tesseraft-bot@users.noreply.github.com", "commit", "-m", "Regenerate README status section via deterministic validation", "--", "README.md", "STATUS.edn"], cwd=worktree, text=True, capture_output=True)
    return execute(check, worktree), True


def report_markdown(results: list[dict[str, Any]]) -> str:
    lines = ["# Tiered deterministic validation", ""]
    for item in results:
        result = item["result"]
        passed = not result["timed_out"] and result["exit_code"] == 0
        lines.extend([
            f"## {item['tier']} / {item['id']} — {'PASS' if passed else 'FAIL'}", "",
            f"Command: `{shlex.join(item['command'])}`", "",
            f"Exit code: `{result['exit_code']}`; timed out: `{str(result['timed_out']).lower()}`; self-healed: `{str(item['self_healed']).lower()}`", "",
            "### stdout", "", "```text", result["stdout"], "```", "",
            "### stderr", "", "```text", result["stderr"], "```", "",
        ])
    return "\n".join(lines)


def main() -> None:
    request = json.load(sys.stdin)
    run = request.get("run", {})
    run_dir = pathlib.Path(request["paths"]["run_dir"]).resolve()
    worktree_raw = run.get("worktree-dir")
    if not worktree_raw:
        raise ValueError("validation requires run.worktree-dir")
    worktree = pathlib.Path(worktree_raw).resolve()
    if not worktree.is_dir():
        raise ValueError(f"worktree does not exist: {worktree}")
    round_number = int(run.get("round", 1))
    results: list[dict[str, Any]] = []
    for tier, check in load_plan(run_dir):
        result = execute(check, worktree)
        result, healed = maybe_self_heal_status(check, result, worktree)
        item = {"tier": tier, "id": check["id"], "command": check["command"], "self_healed": healed, "result": result}
        results.append(item)
        if result["timed_out"] or result["exit_code"] != 0:
            break
    failed_item = next((item for item in results if item["result"]["timed_out"] or item["result"]["exit_code"] != 0), None)
    status = "fail" if failed_item else "pass"
    report_rel = f"validation/report-{round_number}.md"
    summary_rel = f"validation/summary-{round_number}.json"
    report_path = confined(run_dir, report_rel)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(report_markdown(results))
    summary = {
        "version": 1, "status": status,
        "checks_run": [{"tier": x["tier"], "id": x["id"], "exit_code": x["result"]["exit_code"], "timed_out": x["result"]["timed_out"], "self_healed": x["self_healed"]} for x in results],
        "failure_fingerprint": None,
    }
    outputs = {"report": report_rel, "summary": summary_rel}
    issues_rel = None
    if failed_item:
        result = failed_item["result"]
        diagnostic = clipped(f"{result['stderr']}\n{result['stdout']}", DIAGNOSTIC_TAIL)
        fingerprint_source = json.dumps({"tier": failed_item["tier"], "id": failed_item["id"], "timed_out": result["timed_out"], "exit_code": result["exit_code"], "diagnostic": diagnostic}, sort_keys=True)
        fingerprint = hashlib.sha256(fingerprint_source.encode()).hexdigest()
        summary["failure_fingerprint"] = fingerprint
        issues_rel = f"validation/issues-{round_number}.json"
        failure_reason = "timed out" if result["timed_out"] else f"exited {result['exit_code']}"
        issue = [{
            "source": "deterministic-validation", "severity": "major",
            "title": f"{failed_item['tier']} check {failed_item['id']} failed",
            "details": f"Command {shlex.join(failed_item['command'])} {failure_reason}. Diagnostic tail:\n{diagnostic}",
            "acceptance_criteria": f"Validation check {failed_item['id']} exits successfully within its timeout."
        }]
        confined(run_dir, issues_rel).write_text(json.dumps(issue, indent=2) + "\n")
        outputs["issues"] = issues_rel
    confined(run_dir, summary_rel).write_text(json.dumps(summary, indent=2) + "\n")
    json.dump({"ok": True, "status": status, "summary": f"tiered deterministic validation {status}", "outputs": outputs, "issues_file": issues_rel}, sys.stdout)
    print()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"validation runner error: {exc}", file=sys.stderr)
        raise SystemExit(2)
