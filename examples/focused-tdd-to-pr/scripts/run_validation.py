#!/usr/bin/env python3
"""Run the focused workflow's final deterministic validation plan.

Expected validation failures return status=fail with process exit 0. Malformed
requests/plans and runner faults exit nonzero so they cannot be reinterpreted as
successful validation.
"""

import json
import pathlib
import shlex
import subprocess
import sys
from typing import Any

MAX_CAPTURE = 50_000


def confined_path(root: pathlib.Path, relative: str) -> pathlib.Path:
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as exc:
        raise ValueError(f"Path escapes run directory: {relative}") from exc
    return candidate


def read_json(path: pathlib.Path) -> dict[str, Any]:
    data = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise ValueError(f"Validation plan must be a JSON object: {path}")
    return data


def validate_command(check: dict[str, Any]) -> list[str]:
    command = check.get("command")
    shell = check.get("shell", False)
    if not isinstance(shell, bool):
        raise ValueError(f"Check {check.get('id')} has non-boolean shell")
    if isinstance(command, list):
        if shell:
            raise ValueError(f"Check {check.get('id')} must use a string command when shell=true")
        if not command or not all(isinstance(item, str) and item for item in command):
            raise ValueError(f"Check {check.get('id')} has an invalid argv command")
        return command
    if isinstance(command, str) and command:
        if not shell:
            raise ValueError(f"Check {check.get('id')} string command requires shell=true")
        return ["bash", "-lc", command]
    raise ValueError(f"Check {check.get('id')} has no valid command")


def load_validation_plan(run_dir: pathlib.Path) -> list[dict[str, Any]]:
    plan = read_json(run_dir / "design" / "validation-plan.json")
    checks = plan.get("checks")
    if plan.get("version") != 1 or not isinstance(checks, list) or not checks:
        raise ValueError("Validation plan requires version 1 and at least one check")
    seen: set[str] = set()
    for check in checks:
        if not isinstance(check, dict) or not isinstance(check.get("id"), str) or not check["id"]:
            raise ValueError("Every validation check requires a non-empty id")
        timeout = check.get("timeout_seconds")
        if not isinstance(timeout, int) or isinstance(timeout, bool) or not 1 <= timeout <= 7200:
            raise ValueError(f"Check {check['id']} timeout_seconds must be between 1 and 7200")
        validate_command(check)
        if check["id"] in seen:
            raise ValueError(f"Duplicate validation check id: {check['id']}")
        seen.add(check["id"])
    return checks


def clipped(text: str | bytes) -> str:
    if isinstance(text, bytes):
        text = text.decode(errors="replace")
    if len(text) <= MAX_CAPTURE:
        return text
    return f"[truncated to last {MAX_CAPTURE} characters]\n" + text[-MAX_CAPTURE:]


def render_command(check: dict[str, Any]) -> str:
    command = check["command"]
    return command if isinstance(command, str) else shlex.join(command)


def run_check(check: dict[str, Any], worktree: pathlib.Path) -> dict[str, Any]:
    try:
        result = subprocess.run(
            validate_command(check), cwd=worktree, text=True, capture_output=True,
            timeout=check["timeout_seconds"],
        )
        return {"id": check["id"], "command": render_command(check),
                "exit_code": result.returncode, "timed_out": False,
                "stdout": clipped(result.stdout), "stderr": clipped(result.stderr)}
    except subprocess.TimeoutExpired as exc:
        return {"id": check["id"], "command": render_command(check),
                "exit_code": None, "timed_out": True,
                "stdout": clipped(exc.stdout or ""), "stderr": clipped(exc.stderr or "")}


def artifact_paths(round_number: int) -> tuple[str, str]:
    return (f"validation/report-{round_number}.md", f"validation/issues-{round_number}.json")


def markdown_report(results: list[dict[str, Any]]) -> str:
    lines = ["# Deterministic repository validation", ""]
    for result in results:
        passed = not result["timed_out"] and result["exit_code"] == 0
        reason = "check passed" if passed else ("check timed out" if result["timed_out"] else f"check exited {result['exit_code']}")
        lines.extend([
            f"## {result['id']} — {'PASS' if passed else 'FAIL'}", "",
            f"Command: `{result['command']}`", "",
            f"Exit code: `{result['exit_code']}`; timed out: `{str(result['timed_out']).lower()}`", "",
            f"Decision: {reason}", "", "### stdout", "", "```text",
            result["stdout"], "```", "", "### stderr", "", "```text",
            result["stderr"], "```", "",
        ])
    return "\n".join(lines)


def validation_issues(results: list[dict[str, Any]]) -> list[dict[str, str]]:
    failures = []
    for result in results:
        if result["timed_out"]:
            failures.append(f"{result['id']}: timed out")
        elif result["exit_code"] != 0:
            failures.append(f"{result['id']}: exited {result['exit_code']}")
    return [{"source": "deterministic-validation", "severity": "major",
             "title": "Deterministic repository validation failed",
             "details": "; ".join(failures),
             "acceptance_criteria": "Every command in design/validation-plan.json exits successfully within its timeout."}]


def main() -> None:
    request = json.load(sys.stdin)
    run = request.get("run", {})
    run_dir = pathlib.Path(request["paths"]["run_dir"]).resolve()
    worktree_raw = run.get("worktree-dir")
    if not worktree_raw:
        raise ValueError("Validation requires run.worktree-dir")
    worktree = pathlib.Path(worktree_raw).resolve()
    if not worktree.is_dir():
        raise ValueError(f"Worktree does not exist: {worktree}")
    round_number = int(run.get("round", 1))
    results = [run_check(check, worktree) for check in load_validation_plan(run_dir)]

    report_rel, issues_rel = artifact_paths(round_number)
    report_path = confined_path(run_dir, report_rel)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(markdown_report(results))

    failed = any(result["timed_out"] or result["exit_code"] != 0 for result in results)
    status = "fail" if failed else "pass"
    outputs = {"report": report_rel}
    response: dict[str, Any] = {"ok": True, "status": status,
                                "summary": f"Deterministic repository validation {status}",
                                "outputs": outputs, "issues_file": None}
    if failed:
        issues_path = confined_path(run_dir, issues_rel)
        issues_path.parent.mkdir(parents=True, exist_ok=True)
        issues_path.write_text(json.dumps(validation_issues(results), indent=2) + "\n")
        outputs["issues"] = issues_rel
        response["issues_file"] = issues_rel
    json.dump(response, sys.stdout)
    print()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"validation runner error: {exc}", file=sys.stderr)
        raise SystemExit(2)
