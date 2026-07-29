#!/usr/bin/env python3
import json
import sys

request = json.load(sys.stdin)
round_ = request["run"]["round"]
max_rounds = request["inputs"]["max-rounds"]

status = "pass" if round_ >= max_rounds else "fail"
json.dump({"status": status}, sys.stdout)
print()
