#!/usr/bin/env python3
import json
import pathlib
import sys
from typing import Any


def session_usage(session_dir: pathlib.Path) -> dict[str, Any]:
    totals = {"responses": 0, "input": 0, "output": 0, "cache_read": 0, "reasoning": 0, "total_tokens": 0, "recorded_cost": 0.0}
    files = list(session_dir.glob("*.jsonl")) if session_dir.exists() else []
    for path in files:
        for line in path.open(errors="replace"):
            try:
                message = json.loads(line).get("message", {})
                usage = message.get("usage")
            except Exception:
                continue
            if not isinstance(usage, dict):
                continue
            totals["responses"] += 1
            totals["input"] += usage.get("input", 0) or 0
            totals["output"] += usage.get("output", 0) or 0
            totals["cache_read"] += usage.get("cacheRead", 0) or 0
            totals["reasoning"] += usage.get("reasoning", 0) or 0
            totals["total_tokens"] += usage.get("totalTokens", 0) or 0
            totals["recorded_cost"] += (usage.get("cost") or {}).get("total", 0) or 0
    totals["sessions"] = len(files)
    totals["recorded_cost"] = round(totals["recorded_cost"], 6)
    return totals


def combined_usage(run_dir: pathlib.Path) -> dict[str, Any]:
    usage = session_usage(run_dir / "pi-sessions")
    pi_sessions = usage["sessions"]
    claude_dir = run_dir / "claude-sessions"
    claude_sessions = len(list(claude_dir.glob("*.txt"))) if claude_dir.exists() else 0
    usage["pi_sessions"] = pi_sessions
    usage["claude_sessions"] = claude_sessions
    usage["sessions"] = pi_sessions + claude_sessions
    usage["claude_token_usage_available"] = False
    return usage


def main() -> None:
    request = json.load(sys.stdin)
    run = request.get("run", {})
    run_dir = pathlib.Path(request["paths"]["run_dir"]).resolve()
    events_path = run_dir / "events.jsonl"
    events = []
    if events_path.exists():
        for line in events_path.read_text(errors="replace").splitlines():
            try:
                events.append(json.loads(line))
            except Exception:
                pass
    finished = [event for event in events if event.get("event") == "node.finished"]
    failed = [event for event in events if event.get("event") == "node.failed"]
    feedback_path = run_dir / "feedback/history.json"
    try:
        feedback = json.loads(feedback_path.read_text()) if feedback_path.exists() else []
    except Exception:
        feedback = []
    pr_created = (run_dir / "pr/pr.json").exists()
    summary = {
        "version": 1,
        "run_id": run.get("id"),
        "workflow": "design-in-practice-to-pr",
        "execution_profile": request.get("inputs", {}).get("execution-profile", "unspecified"),
        "round": run.get("round"),
        "status_at_recording": run.get("status"),
        "pr_created": pr_created,
        "node_finished_count": len(finished),
        "node_failed_count": len(failed),
        "feedback_cycles": len(feedback) if isinstance(feedback, list) else 0,
        "failure_fingerprints": [x.get("failure_fingerprint") for x in feedback if isinstance(x, dict)] if isinstance(feedback, list) else [],
        "supervision_count": len(list((run_dir / "supervision").glob("status-*.json"))),
        "usage": combined_usage(run_dir),
        "note": "Token totals include cache reads when reported by the executor. Claude Code session count is recorded, but its CLI executor does not report token or cost totals; CLI limit failures are the stopping signal. This artifact does not mutate workflow guidance."
    }
    out = run_dir / "learning/run-summary.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(summary, indent=2) + "\n")
    json.dump({"ok": True, "status": "pass", "pr_created": pr_created, "outputs": {"summary": "learning/run-summary.json"}}, sys.stdout)
    print()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"record learning error: {exc}", file=sys.stderr)
        raise SystemExit(2)
