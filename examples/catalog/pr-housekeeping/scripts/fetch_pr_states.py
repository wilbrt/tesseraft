#!/usr/bin/env python3
import json
import pathlib
import subprocess
import sys

FIELDS = "number,title,headRefName,baseRefName,url,isDraft,reviewDecision,mergeStateStatus,mergeable,statusCheckRollup,updatedAt,author,comments,reviews,latestReviews"


def run(cmd):
    return subprocess.run(cmd, text=True, capture_output=True, check=True).stdout


def main():
    request = json.load(sys.stdin)
    run_dir = pathlib.Path(request["paths"]["run_dir"])
    open_prs_path = run_dir / "housekeeping" / "open-prs.json"
    prs = json.loads(open_prs_path.read_text())

    states = []
    for pr in prs:
        number = str(pr["number"])
        raw = run(["gh", "pr", "view", number, "--json", FIELDS])
        state = json.loads(raw)
        states.append(state)

    out_dir = run_dir / "housekeeping"
    path = out_dir / "pr-states.json"
    path.write_text(json.dumps(states, indent=2) + "\n")

    json.dump({"ok": True, "status": "ok", "outputs": {"pr-states": "housekeeping/pr-states.json"}, "count": len(states)}, sys.stdout)
    print()


if __name__ == "__main__":
    main()
