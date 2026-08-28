#!/usr/bin/env python3
import json
import pathlib
import sys


request = json.load(sys.stdin)
run_dir = pathlib.Path(request["paths"]["run_dir"])
marker = run_dir / "review-count.txt"
review_count = int(marker.read_text()) if marker.exists() else 0
marker.write_text(str(review_count + 1))

if review_count == 0:
    issues = run_dir / "review" / "issues.json"
    issues.parent.mkdir(parents=True, exist_ok=True)
    issues.write_text(json.dumps([
        {
            "source": "independent-review",
            "title": "Address the review fixture",
            "details": "The resumed implementation must receive this durable issue."
        }
    ]))
    print(json.dumps({
        "ok": True,
        "status": "fail",
        "issues_file": "review/issues.json"
    }))
else:
    print(json.dumps({"ok": True, "status": "pass"}))
