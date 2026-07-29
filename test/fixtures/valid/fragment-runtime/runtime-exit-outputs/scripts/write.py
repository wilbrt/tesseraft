#!/usr/bin/env python3
import json
import pathlib
import sys

request = json.load(sys.stdin)
run_dir = pathlib.Path(request["paths"]["run_dir"])

out_dir = run_dir / "artifacts"
out_dir.mkdir(parents=True, exist_ok=True)
(out_dir / "status.json").write_text(json.dumps({"status": "pass"}) + "\n")

json.dump({"status": "pass", "ok": True}, sys.stdout)
print()
