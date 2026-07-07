#!/usr/bin/env python3
import json
import pathlib
import sys


def main():
    request = json.load(sys.stdin)
    inputs = request.get("inputs", {})
    run_dir = pathlib.Path(request["paths"]["run_dir"])
    out_dir = run_dir / "conflict-repair"
    out_dir.mkdir(parents=True, exist_ok=True)

    actions = json.loads((run_dir / "housekeeping" / "actions.json").read_text())
    processed_path = run_dir / "housekeeping" / "processed-prs.json"
    processed = json.loads(processed_path.read_text()) if processed_path.exists() else {"conflict": [], "comment": []}
    processed_conflicts = {int(v) for v in processed.get("conflict", [])}
    target = inputs.get("target-pr")
    candidates = [item for item in actions if item.get("action") in ("fix-conflicts", "fix-tests") and int(item.get("number")) not in processed_conflicts]
    if target:
        target_num = int(target)
        candidates = [item for item in candidates if int(item.get("number")) == target_num]

    if not candidates:
        reason = "no conflict/test-failure PR target found" if not target else f"PR #{target} is not classified as fix-conflicts or fix-tests"
        (out_dir / "selection.json").write_text(json.dumps({"selected": False, "reason": reason}, indent=2) + "\n")
        json.dump({"ok": True, "status": "skip", "reason": reason, "outputs": {"selection": "conflict-repair/selection.json"}}, sys.stdout)
        print(); return

    match = candidates[0]
    target_num = int(match["number"])
    selection = {"selected": True, "pr": match, "auto_selected": not bool(target)}
    (out_dir / "selection.json").write_text(json.dumps(selection, indent=2) + "\n")
    (out_dir / "target-pr.txt").write_text(str(target_num) + "\n")
    json.dump({"ok": True, "status": "pass", "outputs": {"selection": "conflict-repair/selection.json", "target-pr": "conflict-repair/target-pr.txt"}}, sys.stdout)
    print()


if __name__ == "__main__":
    main()
