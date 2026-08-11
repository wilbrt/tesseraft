#!/usr/bin/env python3
"""Run the Playwright browser suite as a retryable workflow outcome.

Expected test failures, missing npm commands, and timeouts return status=fail
with process exit 0. Malformed runtime requests exit nonzero so runner faults
cannot be mistaken for a test result.
"""

import json
import pathlib
import subprocess
import sys
from typing import Any

COMMAND = ["npm", "run", "web:e2e"]
TIMEOUT_SECONDS = 25 * 60
MAX_CAPTURE = 50_000


def confined_path(root: pathlib.Path, relative: str) -> pathlib.Path:
    candidate = (root / relative).resolve()
    try:
        candidate.relative_to(root.resolve())
    except ValueError as exc:
        raise ValueError(f"Path escapes run directory: {relative}") from exc
    return candidate


def clipped(text: str | bytes) -> str:
    if isinstance(text, bytes):
        text = text.decode(errors="replace")
    if len(text) <= MAX_CAPTURE:
        return text
    return f"[truncated to last {MAX_CAPTURE} characters]\n" + text[-MAX_CAPTURE:]


def run_playwright(worktree: pathlib.Path) -> dict[str, Any]:
    try:
        result = subprocess.run(
            COMMAND,
            cwd=worktree,
            text=True,
            capture_output=True,
            timeout=TIMEOUT_SECONDS,
        )
        return {
            "exit_code": result.returncode,
            "timed_out": False,
            "stdout": clipped(result.stdout),
            "stderr": clipped(result.stderr),
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "exit_code": None,
            "timed_out": True,
            "stdout": clipped(exc.stdout or ""),
            "stderr": clipped(exc.stderr or ""),
        }
    except FileNotFoundError as exc:
        return {
            "exit_code": 127,
            "timed_out": False,
            "stdout": "",
            "stderr": str(exc),
        }


def artifact_paths(round_number: int) -> tuple[str, str]:
    return (
        f"playwright/report-{round_number}.md",
        f"playwright/issues-{round_number}.json",
    )


def markdown_report(result: dict[str, Any]) -> str:
    passed = not result["timed_out"] and result["exit_code"] == 0
    if passed:
        decision = "Playwright suite passed."
    elif result["timed_out"]:
        decision = f"Playwright suite timed out after {TIMEOUT_SECONDS} seconds."
    else:
        decision = f"Playwright suite exited with code {result['exit_code']}."
    return "\n".join([
        "# Playwright browser test report",
        "",
        f"Result: **{'PASS' if passed else 'FAIL'}**",
        "",
        f"Command: `{' '.join(COMMAND)}`",
        "",
        f"Exit code: `{result['exit_code']}`; timed out: `{str(result['timed_out']).lower()}`",
        "",
        decision,
        "",
        "## stdout",
        "",
        "```text",
        result["stdout"],
        "```",
        "",
        "## stderr",
        "",
        "```text",
        result["stderr"],
        "```",
        "",
    ])


def playwright_issues(result: dict[str, Any]) -> list[dict[str, str]]:
    if result["timed_out"]:
        details = f"npm run web:e2e timed out after {TIMEOUT_SECONDS} seconds."
    elif result["exit_code"] == 127:
        details = f"npm could not be executed: {result['stderr']}"
    else:
        details = f"npm run web:e2e exited with code {result['exit_code']}. See the Playwright report for captured output."
    return [{
        "source": "playwright-testing",
        "severity": "major",
        "title": "Playwright browser tests failed",
        "details": details,
        "acceptance_criteria": "npm run web:e2e exits successfully in the implementation worktree.",
    }]


def main() -> None:
    request = json.load(sys.stdin)
    run = request.get("run", {})
    run_dir = pathlib.Path(request["paths"]["run_dir"]).resolve()
    worktree_raw = run.get("worktree-dir")
    if not worktree_raw:
        raise ValueError("Playwright testing requires run.worktree-dir")
    worktree = pathlib.Path(worktree_raw).resolve()
    if not worktree.is_dir():
        raise ValueError(f"Worktree does not exist: {worktree}")
    round_number = int(run.get("round", 1))

    result = run_playwright(worktree)
    report_rel, issues_rel = artifact_paths(round_number)
    report_path = confined_path(run_dir, report_rel)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(markdown_report(result))

    failed = result["timed_out"] or result["exit_code"] != 0
    status = "fail" if failed else "pass"
    outputs = {"report": report_rel}
    response: dict[str, Any] = {
        "ok": True,
        "status": status,
        "summary": f"Playwright browser tests {status}",
        "outputs": outputs,
        "issues_file": None,
    }
    if failed:
        issues_path = confined_path(run_dir, issues_rel)
        issues_path.parent.mkdir(parents=True, exist_ok=True)
        issues_path.write_text(json.dumps(playwright_issues(result), indent=2) + "\n")
        outputs["issues"] = issues_rel
        response["issues_file"] = issues_rel

    json.dump(response, sys.stdout)
    print()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"Playwright runner error: {exc}", file=sys.stderr)
        raise SystemExit(2)
