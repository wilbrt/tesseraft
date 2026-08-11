#!/usr/bin/env python3
"""Route every third failed correction cycle through the supervisor.

Runs begin at round 1 and every retry transition increments the round before
entering this node. Therefore rounds 4, 7, 10, ... follow 3, 6, 9, ... failed
correction cycles. The calculation depends only on durable run state, so resume
does not duplicate or skip a checkpoint.
"""

import json
import sys
from typing import Any


def supervision_route(request: dict[str, Any]) -> str:
    run = request.get("run")
    if not isinstance(run, dict):
        raise ValueError("supervision check requires run context")
    round_value = run.get("round")
    if isinstance(round_value, bool):
        raise ValueError("run.round must be a positive integer")
    try:
        round_number = int(round_value)
    except (TypeError, ValueError) as exc:
        raise ValueError("run.round must be a positive integer") from exc
    if round_number < 1:
        raise ValueError("run.round must be a positive integer")
    return "supervise" if round_number > 1 and (round_number - 1) % 3 == 0 else "continue"


def main() -> None:
    request = json.load(sys.stdin)
    route = supervision_route(request)
    round_number = int(request["run"]["round"])
    json.dump({
        "ok": True,
        "status": "pass",
        "summary": f"round {round_number}: {route}",
        "route": route,
        "issues_file": None,
    }, sys.stdout)
    print()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"supervision cadence error: {exc}", file=sys.stderr)
        raise SystemExit(2)
