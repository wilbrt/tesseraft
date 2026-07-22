#!/usr/bin/env python3
"""Run Focused TDD check manifests and return a declared workflow outcome.

Expected test-gate failures are emitted as JSON status=fail with process exit 0.
Malformed requests/manifests and runner faults exit nonzero so Tesseraft records
an external process failure instead of following a normal retry transition.
"""

import json
import pathlib
import re
import shlex
import subprocess
import sys
from typing import Any

MAX_CAPTURE = 50_000
VALID_PHASES = {"red", "green", "refactor", "regression"}


def natural_key(path: pathlib.Path) -> list[tuple[int, Any]]:
    return [(1, int(part)) if part.isdigit() else (0, part) for part in re.split(r"(\d+)", path.name)]


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
        raise ValueError(f"Manifest must be a JSON object: {path}")
    return data


def validate_command(check: dict[str, Any]) -> tuple[list[str], bool]:
    command = check.get("command")
    shell = check.get("shell", False)
    if not isinstance(shell, bool):
        raise ValueError(f"Check {check.get('id')} has non-boolean shell")
    if isinstance(command, list):
        if shell:
            raise ValueError(f"Check {check.get('id')} must use a string command when shell=true")
        if not command or not all(isinstance(item, str) and item for item in command):
            raise ValueError(f"Check {check.get('id')} has an invalid argv command")
        return command, False
    if isinstance(command, str) and command:
        if not shell:
            raise ValueError(f"Check {check.get('id')} string command requires shell=true")
        return ["bash", "-lc", command], True
    raise ValueError(f"Check {check.get('id')} has no valid command")


def validate_check(check: dict[str, Any], focused: bool) -> None:
    if not isinstance(check.get("id"), str) or not check["id"]:
        raise ValueError("Every check requires a non-empty id")
    timeout = check.get("timeout_seconds")
    if not isinstance(timeout, int) or isinstance(timeout, bool) or not 1 <= timeout <= 7200:
        raise ValueError(f"Check {check['id']} timeout_seconds must be between 1 and 7200")
    validate_command(check)
    if focused:
        if check.get("version") != 1:
            raise ValueError(f"Focused check {check['id']} requires version 1")
        if not isinstance(check.get("scenario_id"), str) or not check["scenario_id"]:
            raise ValueError(f"Focused check {check['id']} requires scenario_id")
        red = check.get("red")
        if not isinstance(red, dict) or red.get("expected_exit") != "nonzero":
            raise ValueError(f"Focused check {check['id']} requires red.expected_exit=nonzero")
        markers = red.get("output_contains")
        if not isinstance(markers, list) or not markers or not all(isinstance(v, str) and v for v in markers):
            raise ValueError(f"Focused check {check['id']} requires non-empty red.output_contains")


def load_focused_checks(run_dir: pathlib.Path) -> list[dict[str, Any]]:
    latest: dict[str, tuple[pathlib.Path, dict[str, Any]]] = {}
    for path in sorted((run_dir / "tdd").glob("check-*.json"), key=natural_key):
        check = read_json(path)
        validate_check(check, focused=True)
        latest[check["scenario_id"]] = (path, check)
    return [entry[1] for entry in latest.values()]


def load_validation_plan(run_dir: pathlib.Path) -> list[dict[str, Any]]:
    path = run_dir / "design" / "validation-plan.json"
    plan = read_json(path)
    if plan.get("version") != 1 or not isinstance(plan.get("checks"), list) or not plan["checks"]:
        raise ValueError("Validation plan requires version 1 and at least one check")
    seen: set[str] = set()
    for check in plan["checks"]:
        if not isinstance(check, dict):
            raise ValueError("Validation plan checks must be objects")
        validate_check(check, focused=False)
        if check["id"] in seen:
            raise ValueError(f"Duplicate validation check id: {check['id']}")
        seen.add(check["id"])
    return plan["checks"]


def render_command(check: dict[str, Any]) -> str:
    command = check["command"]
    return command if isinstance(command, str) else shlex.join(command)


def clipped(text: str | bytes) -> str:
    if isinstance(text, bytes):
        text = text.decode(errors="replace")
    if len(text) <= MAX_CAPTURE:
        return text
    return f"[truncated to last {MAX_CAPTURE} characters]\n" + text[-MAX_CAPTURE:]


def run_check(check: dict[str, Any], worktree: pathlib.Path) -> dict[str, Any]:
    argv, _ = validate_command(check)
    try:
        result = subprocess.run(
            argv,
            cwd=worktree,
            text=True,
            capture_output=True,
            timeout=check["timeout_seconds"],
        )
        return {
            "id": check["id"],
            "command": render_command(check),
            "exit_code": result.returncode,
            "timed_out": False,
            "stdout": clipped(result.stdout),
            "stderr": clipped(result.stderr),
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "id": check["id"],
            "command": render_command(check),
            "exit_code": None,
            "timed_out": True,
            "stdout": clipped(exc.stdout or ""),
            "stderr": clipped(exc.stderr or ""),
        }


def red_passed(check: dict[str, Any], result: dict[str, Any]) -> tuple[bool, str]:
    if result["timed_out"]:
        return False, "focused test timed out"
    if result["exit_code"] == 0:
        return False, "focused test unexpectedly passed before implementation"
    output = result["stdout"] + "\n" + result["stderr"]
    missing = [marker for marker in check["red"]["output_contains"] if marker not in output]
    if missing:
        return False, "expected red evidence missing: " + ", ".join(repr(v) for v in missing)
    return True, "nonzero exit and expected red evidence observed"


def green_passed(result: dict[str, Any]) -> tuple[bool, str]:
    if result["timed_out"]:
        return False, "check timed out"
    if result["exit_code"] != 0:
        return False, f"check exited {result['exit_code']}"
    return True, "check passed"


def git_evidence(worktree: pathlib.Path) -> tuple[str, str]:
    def git(*args: str, accepted: tuple[int, ...] = (0,)) -> str:
        result = subprocess.run(["git", *args], cwd=worktree, text=True, capture_output=True, timeout=15)
        if result.returncode in accepted:
            return result.stdout
        raise RuntimeError(f"git {' '.join(args)} failed: {result.stderr}")

    status = git("status", "--short", "--untracked-files=all")
    diff_parts = [git("diff", "HEAD", "--no-ext-diff", "--unified=20")]
    untracked = git("ls-files", "--others", "--exclude-standard", "-z").split("\0")
    for relative in filter(None, untracked):
        diff_parts.append(git(
            "diff", "--no-index", "--no-ext-diff", "--unified=20", "--", "/dev/null", relative,
            accepted=(0, 1),
        ))
    return status, clipped("".join(diff_parts))


def latest_test_list(run_dir: pathlib.Path) -> pathlib.Path:
    snapshots = [path for path in (run_dir / "test-list").glob("scenarios-*.json")
                 if path.name != "scenarios-initial.json"]
    if snapshots:
        return sorted(snapshots, key=natural_key)[-1]
    return run_dir / "test-list" / "scenarios-initial.json"


def pending_scenarios(run_dir: pathlib.Path) -> list[str]:
    path = latest_test_list(run_dir)
    data = read_json(path)
    scenarios = data.get("scenarios")
    if not isinstance(scenarios, list):
        raise ValueError(f"Test list has no scenarios array: {path}")
    return [str(item.get("id", "<unknown>")) for item in scenarios
            if isinstance(item, dict) and item.get("state") == "pending"]


def artifact_paths(phase: str, round_number: int) -> tuple[str, str]:
    if phase == "regression":
        return (f"validation/report-{round_number}.md", f"validation/issues-{round_number}.json")
    return (f"tdd/{phase}-verification-{round_number}.md", f"tdd/{phase}-verification-issues-{round_number}.json")


def markdown_report(phase: str, results: list[dict[str, Any]], verdicts: list[tuple[bool, str]],
                    changed_files: str = "", diff: str = "", pending: list[str] | None = None) -> str:
    lines = [f"# Deterministic {phase} validation", ""]
    if pending is not None:
        lines.extend(["## Test-list completion", "", "Pending: " + (", ".join(pending) if pending else "none"), ""])
    for result, (passed, reason) in zip(results, verdicts):
        lines.extend([
            f"## {result['id']} — {'PASS' if passed else 'FAIL'}",
            "",
            f"Command: `{result['command']}`",
            "",
            f"Exit code: `{result['exit_code']}`; timed out: `{str(result['timed_out']).lower()}`",
            "",
            f"Decision: {reason}",
            "",
            "### stdout",
            "",
            "```text",
            result["stdout"],
            "```",
            "",
            "### stderr",
            "",
            "```text",
            result["stderr"],
            "```",
            "",
        ])
    if phase == "red":
        lines.extend(["## Changed files", "", "```text", changed_files, "```", "", "## Diff", "", "```diff", diff, "```", ""])
    return "\n".join(lines)


def issue_for(phase: str, failures: list[str]) -> list[dict[str, str]]:
    return [{
        "source": f"{phase}-validation",
        "severity": "major",
        "title": f"Deterministic {phase} validation failed",
        "details": "; ".join(failures),
        "acceptance_criteria": f"All declared {phase} checks satisfy their expected outcomes.",
    }]


def main() -> None:
    request = json.load(sys.stdin)
    run = request.get("run", {})
    node_inputs = request.get("node", {}).get("inputs", {})
    phase = node_inputs.get("phase")
    if phase not in VALID_PHASES:
        raise ValueError(f"Unknown validation phase: {phase}")
    run_dir = pathlib.Path(request["paths"]["run_dir"]).resolve()
    worktree_raw = run.get("worktree-dir")
    if not worktree_raw:
        raise ValueError("Validation requires run.worktree-dir")
    worktree = pathlib.Path(worktree_raw).resolve()
    if not worktree.is_dir():
        raise ValueError(f"Worktree does not exist: {worktree}")
    round_number = int(run.get("round", 1))

    pending = None
    if phase == "red":
        relative = str(node_inputs.get("manifest-file", "")).replace("{{run.round}}", str(round_number))
        manifest = read_json(confined_path(run_dir, relative))
        validate_check(manifest, focused=True)
        checks = [manifest]
    elif phase in {"green", "refactor"}:
        checks = load_focused_checks(run_dir)
        if not checks:
            raise ValueError(f"No focused checks found for {phase}")
    else:
        pending = pending_scenarios(run_dir)
        broad = load_validation_plan(run_dir)
        focused = load_focused_checks(run_dir)
        checks = [dict(check, id=f"broad:{check['id']}") for check in broad]
        checks.extend(dict(check, id=f"focused:{check['scenario_id']}:{check['id']}") for check in focused)

    results = [run_check(check, worktree) for check in checks]
    if phase == "red":
        verdicts = [red_passed(checks[0], results[0])]
        changed_files, diff = git_evidence(worktree)
    else:
        verdicts = [green_passed(result) for result in results]
        changed_files, diff = "", ""
    failures = [f"{result['id']}: {reason}" for result, (passed, reason) in zip(results, verdicts) if not passed]
    if phase == "red" and (not changed_files.strip() or not diff.strip()):
        failures.append("red evidence requires non-empty worktree changes and diff; test authoring may not commit changes")
    if pending:
        failures.append("pending test scenarios remain: " + ", ".join(pending))

    report_rel, issues_rel = artifact_paths(phase, round_number)
    report_path = confined_path(run_dir, report_rel)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(markdown_report(phase, results, verdicts, changed_files, diff, pending))

    status = "pass" if not failures else "fail"
    outputs = {"report": report_rel}
    response: dict[str, Any] = {
        "ok": True,
        "status": status,
        "summary": f"Deterministic {phase} validation {status}",
        "outputs": outputs,
        "issues_file": None,
    }
    if failures:
        issues_path = confined_path(run_dir, issues_rel)
        issues_path.parent.mkdir(parents=True, exist_ok=True)
        issues_path.write_text(json.dumps(issue_for(phase, failures), indent=2) + "\n")
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
