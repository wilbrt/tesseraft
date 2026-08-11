#!/usr/bin/env python3
import json
import pathlib
import sys

MAX_BYTES = 4096
REQUIRED = {"decision", "failure_class", "earliest_discrepancy", "validated_prefix", "next_actions", "unknowns", "evidence"}


def main() -> None:
    request = json.load(sys.stdin)
    run_dir = pathlib.Path(request["paths"]["run_dir"]).resolve()
    path = run_dir / "supervision/current.json"
    raw = path.read_bytes()
    data = json.loads(raw)
    valid = isinstance(data, dict) and REQUIRED.issubset(data) and data.get("decision") in {"continue", "redirect", "intervene"} and len(raw) <= MAX_BYTES
    route = "continue" if valid and data["decision"] in {"continue", "redirect"} else "intervene"
    json.dump({"ok": True, "status": "pass", "route": route, "summary": "supervision handoff accepted" if valid else "supervision handoff requires intervention"}, sys.stdout)
    print()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"supervision check error: {exc}", file=sys.stderr)
        raise SystemExit(2)
