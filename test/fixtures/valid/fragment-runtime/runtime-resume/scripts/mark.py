#!/usr/bin/env python3
import json
import pathlib
import sys

request = json.load(sys.stdin)
run_dir = pathlib.Path(request["paths"]["run_dir"])

marks_path = run_dir / "marks.txt"
with marks_path.open("a") as f:
    f.write("mark\n")

json.dump({"status": "pass", "ok": True}, sys.stdout)
print()
