#!/usr/bin/env python3
import json
import pathlib
import subprocess
import sys


def run(cmd):
    return subprocess.run(cmd, text=True, capture_output=True, check=True).stdout


def main():
    request = json.load(sys.stdin)
    run_dir = pathlib.Path(request["paths"]["run_dir"])
    inputs = request.get("inputs", {})
    max_prs = int(inputs.get("max-prs") or 20)

    out_dir = run_dir / "housekeeping"
    out_dir.mkdir(parents=True, exist_ok=True)

    raw = run([
        "gh", "pr", "list",
        "--state", "open",
        "--limit", str(max_prs),
        "--json", "number,title,headRefName,baseRefName,url,isDraft,reviewDecision,mergeStateStatus,statusCheckRollup,updatedAt,author"
    ])
    prs = json.loads(raw)
    path = out_dir / "open-prs.json"
    path.write_text(json.dumps(prs, indent=2) + "\n")

    json.dump({"ok": True, "status": "ok", "outputs": {"open-prs": "housekeeping/open-prs.json"}, "count": len(prs)}, sys.stdout)
    print()


if __name__ == "__main__":
    main()
