#!/usr/bin/env python3
import json
import pathlib
import subprocess
import sys


request = json.load(sys.stdin)
run = request["run"]
attempt = run["attempt"]
run_dir = pathlib.Path(request["paths"]["run_dir"])
repo_root = pathlib.Path(request["inputs"]["repo-root"]).resolve()
report_path = run_dir / "checks" / f"report-{attempt}.md"
issues_path = run_dir / "checks" / f"issues-{attempt}.json"
report_path.parent.mkdir(parents=True, exist_ok=True)

completed = subprocess.run(
    ["bb", "test"],
    cwd=repo_root,
    text=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    check=False,
)
report_path.write_text(
    "# Deterministic check report\n\n"
    f"Exit code: `{completed.returncode}`\n\n"
    "```text\n"
    f"{completed.stdout}"
    "\n```\n"
)

if completed.returncode == 0:
    print(json.dumps({"ok": True, "status": "pass"}))
else:
    issues_path.write_text(json.dumps([
        {
            "source": "deterministic-checks",
            "title": "bb test failed",
            "details": "Read the activation-stamped check report for the complete output."
        }
    ]))
    print(json.dumps({
        "ok": True,
        "status": "fail",
        "issues_file": f"checks/issues-{attempt}.json"
    }))
