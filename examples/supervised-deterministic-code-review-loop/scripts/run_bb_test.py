#!/usr/bin/env python3
"""Run the deterministic `bb test` smoke suite as a retryable workflow outcome.

This is the deterministic-first gate #1: it runs the project's `bb test`
(smoke suite) in the implementation worktree. Expected test failures,
missing `bb`/`test` commands, and timeouts return status=fail with process
exit 0 so tesseraft follows the normal retry transition back to :implement.
Malformed runtime requests exit nonzero so a runner fault can never be
mistaken for a test result (matching run_playwright.py's contract).

Note: `bb test` invokes this repo's `scripts/test.sh`, which lints example
workflows and runs several local suites relative to the cwd it is invoked
from. We invoke it in the isolated worktree so the gate tests the agent's
actual checkout, not the developer's working repo. The worktree has its own
`examples/`, `scripts/`, and `bb.edn`, so the relative paths resolve within
the worktree.

## Self-healing the STATUS.edn ↔ README.md sync drift

`scripts/test.sh` ends with `bb status --check`, which fails when README's
generated STATUS section is out of sync with STATUS.edn. The implement
agent is forbidden from running `bb status` (agents run no `bb`/test
commands), so a run that edits STATUS.edn but not README would otherwise
dead-loop on this gate until `max-rounds` is exhausted. To remove that
loop, this gate self-heals the one derived artifact it owns:

  - when `bb test` fails AND the failure is specifically the sync check
    (its output contains "out of sync with STATUS.edn"), the gate runs
    `bb status` in the worktree to regenerate README from STATUS.edn,
    commits README.md + STATUS.edn on the worktree branch, and re-runs
    `bb test` exactly once;
  - non-sync failures are never masked (no regeneration, no second run);
  - regeneration/commit failures are swallowed so they can never turn a
    real test failure into a spurious pass or a runner fault.

CI/developer `bb test` is unchanged — `bb status --check` still enforces
drift for humans; only the workflow's deterministic gate self-heals.
"""

import json
import pathlib
import subprocess
import sys
from typing import Any

COMMAND = ["bb", "test"]
TIMEOUT_SECONDS = 12 * 60
MAX_CAPTURE = 50_000

REGEN_COMMAND = ["bb", "status"]
SYNC_MARKER = "out of sync with STATUS.edn"
SELF_HEAL_COMMIT_MESSAGE = (
    "Regenerate README status section via bb status (deterministic gate self-heal)"
)
DEFAULT_GIT_AUTHOR_NAME = "tesseraft-bot"
DEFAULT_GIT_AUTHOR_EMAIL = "tesseraft-bot@users.noreply.github.com"


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


def run_bb_test(worktree: pathlib.Path) -> dict[str, Any]:
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


def failed_due_to_status_sync(result: dict[str, Any]) -> bool:
    """True only when the bb test failure is specifically the STATUS↔README sync drift.

    A pass, a timeout, or a `bb`-missing (127) result is never a sync failure.
    """
    if result.get("timed_out") or result.get("exit_code") == 0:
        return False
    if result.get("exit_code") == 127:
        return False
    blob = f"{result.get('stdout', '')}\n{result.get('stderr', '')}"
    return SYNC_MARKER in blob


def _git(worktree: pathlib.Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["git", "-C", str(worktree), *args],
        text=True,
        capture_output=True,
    )


def regenerate_status_in_worktree(worktree: pathlib.Path) -> bool:
    """Run `bb status` in the worktree to regenerate README from STATUS.edn.

    Returns True if README.md changed as a result. Never raises: a regeneration
    failure is swallowed so the gate reports the original bb test failure
    instead of masking it with a runner fault.
    """
    try:
        subprocess.run(
            REGEN_COMMAND,
            cwd=worktree,
            text=True,
            capture_output=True,
            timeout=120,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False
    diff = _git(worktree, "diff", "--name-only", "--", "README.md")
    return bool(diff.stdout.strip())


def commit_status_sync(
    worktree: pathlib.Path,
    *,
    author_name: str = DEFAULT_GIT_AUTHOR_NAME,
    author_email: str = DEFAULT_GIT_AUTHOR_EMAIL,
) -> bool:
    """Commit the regenerated README.md together with STATUS.edn on the worktree branch.

    Only README.md and STATUS.edn are staged (never other worktree changes).
    Returns True if a commit was created. Never raises.
    """
    _git(worktree, "add", "README.md", "STATUS.edn")
    staged = _git(worktree, "diff", "--cached", "--name-only")
    if not staged.stdout.strip():
        return False
    commit = _git(
        worktree,
        "-c", f"user.name={author_name}",
        "-c", f"user.email={author_email}",
        "commit", "-m", SELF_HEAL_COMMIT_MESSAGE,
        "--", "README.md", "STATUS.edn",
    )
    return commit.returncode == 0


def self_heal_status_sync(worktree: pathlib.Path) -> bool:
    """Regenerate README from STATUS.edn and commit it. Returns True if README changed."""
    if not regenerate_status_in_worktree(worktree):
        return False
    commit_status_sync(worktree)
    return True


def artifact_paths(round_number: int) -> tuple[str, str]:
    return (
        f"bb-test/report-{round_number}.md",
        f"bb-test/issues-{round_number}.json",
    )


def markdown_report(result: dict[str, Any], *, healed: bool = False) -> str:
    passed = not result["timed_out"] and result["exit_code"] == 0
    if passed:
        decision = "bb test suite passed."
    elif result["timed_out"]:
        decision = f"bb test suite timed out after {TIMEOUT_SECONDS} seconds."
    else:
        decision = f"bb test suite exited with code {result['exit_code']}."
    note = ""
    if healed:
        if passed:
            note = (
                "\n\n## Self-heal\n\nThe first `bb test` failed the "
                "`bb status --check` STATUS.edn ↔ README.md sync gate. The "
                "gate ran `bb status` to regenerate README.md from STATUS.edn, "
                "committed README.md + STATUS.edn on this worktree branch, and "
                "re-ran `bb test` once. The second run passed.\n"
            )
        else:
            note = (
                "\n\n## Self-heal\n\nThe gate attempted to self-heal a "
                "STATUS.edn ↔ README.md sync drift via `bb status`, but the "
                "second `bb test` run still failed. See the captured output.\n"
            )
    return "\n".join([
        "# bb test suite report",
        "",
        f"Result: **{'PASS' if passed else 'FAIL'}**",
        "",
        f"Command: `{' '.join(COMMAND)}`",
        "",
        f"Exit code: `{result['exit_code']}`; timed out: `{str(result['timed_out']).lower()}`",
        "",
        decision,
        note,
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


def bb_test_issues(result: dict[str, Any]) -> list[dict[str, str]]:
    if result["timed_out"]:
        details = f"`bb test` timed out after {TIMEOUT_SECONDS} seconds."
    elif result["exit_code"] == 127:
        details = f"`bb` could not be executed: {result['stderr']}"
    else:
        details = f"`bb test` exited with code {result['exit_code']}. See the bb test report for captured output."
    return [{
        "source": "bb-test-gate",
        "severity": "major",
        "title": "Deterministic bb test suite failed",
        "details": details,
        "acceptance_criteria": "`bb test` exits successfully in the implementation worktree.",
    }]


def main() -> None:
    request = json.load(sys.stdin)
    run = request.get("run", {})
    run_dir = pathlib.Path(request["paths"]["run_dir"]).resolve()
    worktree_raw = run.get("worktree-dir")
    if not worktree_raw:
        raise ValueError("bb test gate requires run.worktree-dir")
    worktree = pathlib.Path(worktree_raw).resolve()
    if not worktree.is_dir():
        raise ValueError(f"Worktree does not exist: {worktree}")
    round_number = int(run.get("round", 1))

    result = run_bb_test(worktree)
    healed = False
    if failed_due_to_status_sync(result) and self_heal_status_sync(worktree):
        # The drift was derived-only (agents must not run `bb status`); regenerate
        # and commit the one derived artifact this gate owns, then re-run once.
        result = run_bb_test(worktree)
        healed = True

    report_rel, issues_rel = artifact_paths(round_number)
    report_path = confined_path(run_dir, report_rel)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(markdown_report(result, healed=healed))

    failed = result["timed_out"] or result["exit_code"] != 0
    status = "fail" if failed else "pass"
    summary = f"bb test suite {status}"
    if healed:
        summary = (
            "bb test suite pass after self-healing README/STATUS sync drift"
            if not failed
            else "bb test suite fail after self-healing README/STATUS sync drift"
        )
    outputs = {"report": report_rel}
    response: dict[str, Any] = {
        "ok": True,
        "status": status,
        "summary": summary,
        "outputs": outputs,
        "issues_file": None,
    }
    if failed:
        issues_path = confined_path(run_dir, issues_rel)
        issues_path.parent.mkdir(parents=True, exist_ok=True)
        issues_path.write_text(json.dumps(bb_test_issues(result), indent=2) + "\n")
        outputs["issues"] = issues_rel
        response["issues_file"] = issues_rel

    json.dump(response, sys.stdout)
    print()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"bb test runner error: {exc}", file=sys.stderr)
        raise SystemExit(2)