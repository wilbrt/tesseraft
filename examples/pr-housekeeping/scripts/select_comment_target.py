#!/usr/bin/env python3
import json
import pathlib
import sys


def main():
    request = json.load(sys.stdin)
    inputs = request.get("inputs", {})
    run_dir = pathlib.Path(request["paths"]["run_dir"])
    out_dir = run_dir / "comment-repair"
    out_dir.mkdir(parents=True, exist_ok=True)

    actions = json.loads((run_dir / "housekeeping" / "actions.json").read_text())
    target = inputs.get("target-pr")
    candidates = [item for item in actions if item.get("needs_response")]
    if target:
        target_num = int(target)
        candidates = [item for item in candidates if int(item.get("number")) == target_num]

    if not candidates:
        reason = "no PR target with detected comments or requested changes" if not target else f"PR #{target} does not have detected comments or requested changes"
        (out_dir / "selection.json").write_text(json.dumps({"selected": False, "reason": reason}, indent=2) + "\n")
        json.dump({"ok": True, "status": "skip", "reason": reason, "outputs": {"selection": "comment-repair/selection.json"}}, sys.stdout)
        print(); return

    match = candidates[0]
    target_num = int(match["number"])
    selection = {"selected": True, "pr": match, "auto_selected": not bool(target)}
    (out_dir / "selection.json").write_text(json.dumps(selection, indent=2) + "\n")
    (out_dir / "target-pr.txt").write_text(str(target_num) + "\n")
    json.dump({"ok": True, "status": "pass", "outputs": {"selection": "comment-repair/selection.json", "target-pr": "comment-repair/target-pr.txt"}}, sys.stdout)
    print()


if __name__ == "__main__":
    main()
