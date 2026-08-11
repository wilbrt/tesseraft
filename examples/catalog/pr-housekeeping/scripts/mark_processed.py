#!/usr/bin/env python3
import json
import pathlib
import sys


def main():
    request = json.load(sys.stdin)
    run_dir = pathlib.Path(request["paths"]["run_dir"])
    node_inputs = request.get("node", {}).get("inputs", {})
    kind = node_inputs.get("kind")
    if kind not in {"conflict", "comment"}:
        raise SystemExit("mark_processed.py requires node input kind=conflict or kind=comment")

    repair_dir = run_dir / ("conflict-repair" if kind == "conflict" else "comment-repair")
    selection = json.loads((repair_dir / "selection.json").read_text())
    pr = selection.get("pr") or {}
    number = int(pr.get("number"))

    path = run_dir / "housekeeping" / "processed-prs.json"
    if path.exists():
        processed = json.loads(path.read_text())
    else:
        processed = {"conflict": [], "comment": []}

    key = "conflict" if kind == "conflict" else "comment"
    values = {int(v) for v in processed.get(key, [])}
    values.add(number)
    processed[key] = sorted(values)
    path.write_text(json.dumps(processed, indent=2) + "\n")

    summary_path = repair_dir / "processed-summary.md"
    summary_path.write_text(f"# Mark processed\n\nMarked PR #{number} as processed for `{kind}`.\n\n```json\n{json.dumps(processed, indent=2)}\n```\n")

    json.dump({"ok": True, "status": "pass", "outputs": {"processed": "housekeeping/processed-prs.json", "summary": f"{repair_dir.name}/processed-summary.md"}}, sys.stdout)
    print()


if __name__ == "__main__":
    main()
