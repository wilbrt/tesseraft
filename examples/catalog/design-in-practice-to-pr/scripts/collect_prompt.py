#!/usr/bin/env python3
import json
import pathlib
import sys


def confined(root: pathlib.Path, relative: str) -> pathlib.Path:
    path = (root / relative).resolve()
    path.relative_to(root.resolve())
    return path


def main() -> None:
    request = json.load(sys.stdin)
    prompt = request.get("inputs", {}).get("prompt")
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValueError("prompt input must be a non-empty string")
    run_dir = pathlib.Path(request["paths"]["run_dir"]).resolve()
    json_path = confined(run_dir, "prompt/prompt.json")
    md_path = confined(run_dir, "prompt/prompt.md")
    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps({"prompt": prompt}, indent=2) + "\n")
    md_path.write_text(prompt.rstrip() + "\n")
    json.dump({"ok": True, "status": "pass", "outputs": {"prompt-json": "prompt/prompt.json", "prompt-md": "prompt/prompt.md"}}, sys.stdout)
    print()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"collect prompt error: {exc}", file=sys.stderr)
        raise SystemExit(2)
