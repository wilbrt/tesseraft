import json
from pathlib import Path

from python_support import ROOT, read_json_lines, run_command, run_control_plane


BIN = str(ROOT / "bin" / "tesseraft")
GOLDEN = ROOT / "test" / "golden"


def expected(name):
    return json.loads((GOLDEN / name).read_text())


def test_normalized_workflow_and_lint_diagnostics_match_goldens():
    normalized = run_command([BIN, "lint", "examples/tutorials/smoke/workflow.edn", "--emit", "normalized"])
    assert normalized.returncode == 0, normalized.stderr
    assert json.loads(normalized.stdout) == expected("normalized-smoke.json")

    linted = run_command([
        BIN, "lint", "test/fixtures/invalid/missing-prompt.workflow.edn", "--format", "json"
    ])
    assert linted.returncode == 1
    payload = json.loads(linted.stdout)
    assert {key: payload[key] for key in ("ok", "errors", "warnings")} == expected("lint-missing-prompt.json")


def test_control_plane_graph_and_run_lifecycle_match_goldens(workspace_layout):
    base = ["--workspace-root", str(workspace_layout.workspace), "--workflow-root", str(ROOT / "examples")]
    graph = run_control_plane([*base, "graph", "smoke-demo"], workspace_layout.home)
    assert graph.returncode == 0, graph.stderr
    assert json.loads(graph.stdout) == expected("graph-smoke.json")

    run = run_command([
        BIN, "run", str(ROOT / "examples/tutorials/smoke/workflow.edn"),
        "--run-id", "golden-smoke", "--workspace-root", str(workspace_layout.workspace),
        "--tesseraft-home", str(workspace_layout.home), "--format", "json",
    ])
    assert run.returncode == 0, run.stderr
    body = json.loads(run.stdout)["run"]
    actual = {key: body[key] for key in ("status", "state", "round", "attempt")}
    events = []
    for event in read_json_lines(Path(body["dir"]) / "events.jsonl"):
        projected = {"event": event["event"]}
        for key in ("state", "attempt", "from", "to"):
            if key in event:
                projected[key] = event[key]
        events.append(projected)
    actual["events"] = events
    assert actual == expected("run-smoke.json")
