#!/usr/bin/env python3
import json
import pathlib
import sys

request = json.load(sys.stdin)
run_dir = pathlib.Path(request["paths"]["run_dir"])
prompt = request.get("inputs", {}).get("prompt", "")

prompt_dir = run_dir / "prompt"
prompt_dir.mkdir(parents=True, exist_ok=True)

prompt_json = prompt_dir / "prompt.json"
prompt_md = prompt_dir / "prompt.md"

prompt_json.write_text(json.dumps({"prompt": prompt}, indent=2) + "\n")
prompt_md.write_text(prompt.rstrip() + "\n")

json.dump({
    "ok": True,
    "status": "ok",
    "outputs": {
        "prompt-json": "prompt/prompt.json",
        "prompt-md": "prompt/prompt.md"
    }
}, sys.stdout)
print()