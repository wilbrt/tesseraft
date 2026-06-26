#!/usr/bin/env python3
import json
import pathlib
import sys


def truthy(value):
    return str(value).lower() in {"1", "true", "yes", "on"}


def main():
    request = json.load(sys.stdin)
    inputs = request.get("inputs", {})
    run_dir = pathlib.Path(request["paths"]["run_dir"])
    out_dir = run_dir / "comment-repair"
    out_dir.mkdir(parents=True, exist_ok=True)

    if not truthy(inputs.get("repair-comments", "false")):
        reason = "repair-comments is false"
        (out_dir / "selection.json").write_text(json.dumps({"selected": False, "reason": reason}, indent=2) + "\n")
        json.dump({"ok": True, "status": "skip", "reason": reason, "outputs": {"selection": "comment-repair/selection.json"}}, sys.stdout)
        print(); return

    target = inputs.get("target-pr")
    if not target:
        reason = "target-pr is required"
        (out_dir / "selection.json").write_text(json.dumps({"selected": False, "reason": reason}, indent=2) + "\n")
        json.dump({"ok": True, "status": "skip", "reason": reason, "outputs": {"selection": "comment-repair/selection.json"}}, sys.stdout)
        print(); return

    target_num = int(target)
    actions = json.loads((run_dir / "housekeeping" / "actions.json").read_text())
    match = next((item for item in actions if int(item.get("number")) == target_num), None)
    if not match:
        reason = f"PR #{target_num} was not found in actions.json"
    elif not match.get("needs_response"):
        reason = f"PR #{target_num} does not have detected comments or requested changes"
    else:
        selection = {"selected": True, "pr": match}
        (out_dir / "selection.json").write_text(json.dumps(selection, indent=2) + "\n")
        (out_dir / "target-pr.txt").write_text(str(target_num) + "\n")
        json.dump({"ok": True, "status": "pass", "outputs": {"selection": "comment-repair/selection.json", "target-pr": "comment-repair/target-pr.txt"}}, sys.stdout)
        print(); return

    (out_dir / "selection.json").write_text(json.dumps({"selected": False, "reason": reason, "pr": match}, indent=2) + "\n")
    json.dump({"ok": True, "status": "skip", "reason": reason, "outputs": {"selection": "comment-repair/selection.json"}}, sys.stdout)
    print()


if __name__ == "__main__":
    main()
