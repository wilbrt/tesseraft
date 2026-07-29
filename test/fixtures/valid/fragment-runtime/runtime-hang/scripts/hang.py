#!/usr/bin/env python3
import json
import os
import pathlib
import sys
import time

request = json.load(sys.stdin)
run_dir = pathlib.Path(request["paths"]["run_dir"])

(run_dir / "hang.pid").write_text(str(os.getpid()))
time.sleep(300)

json.dump({"status": "pass", "ok": True}, sys.stdout)
print()
