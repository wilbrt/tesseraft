#!/usr/bin/env python3
import json
import pathlib
import sys

request = json.load(sys.stdin)
run_dir = pathlib.Path(request["paths"]["run_dir"])

result_dir = run_dir / "process"
result_dir.mkdir(parents=True, exist_ok=True)
(result_dir / "result.json").write_text(json.dumps({"ran": True}) + "\n")

json.dump({"status": "pass", "ok": True}, sys.stdout)
print()
