import json
from copy import deepcopy
from pathlib import Path

from jsonschema import Draft202012Validator

from python_support import ROOT, read_json_lines, run_command


BIN = str(ROOT / "bin" / "tesseraft")


def workflow_contract():
    return {
        "api-version": "tesseraft.workflow/v1",
        "kind": "workflow",
        "metadata": {"name": "resumable-session-contract"},
        "inputs": {"prompt": {"type": "string", "required": True}},
        "defaults": {"max-rounds": 3, "state-timeout": "1m"},
        "policies": {"require-timeouts": True, "require-max-rounds": True},
        "initial": "implement",
        "states": {
            "implement": {
                "type": "agent",
                "executor": "pi-cli",
                "prompt-template": "prompts/initial.md.tmpl",
                "prompt-output": "prompts/generated/initial-{{run.attempt}}.md",
                "session": {
                    "mode": "resumable",
                    "continuation-prompt-template": "prompts/continuation.md.tmpl",
                    "continuation-prompt-output": "prompts/generated/continuation-{{run.attempt}}.md",
                },
                "tools": ["read"],
                "runtime": {"timeout": "1m"},
                "outputs": {
                    "status": {
                        "path": "execution/status-{{run.attempt}}.json",
                        "required": True,
                    }
                },
                "transitions": [
                    {"when": {"status": "pass"}, "next": "done"},
                    {
                        "when": {"status": "fail"},
                        "effects": ["inc-round"],
                        "next": "implement",
                    },
                ],
            },
            "done": {"type": "terminal", "status": "success"},
        },
    }


def schema_errors(schema_name, instance):
    schema = json.loads((ROOT / "schemas" / schema_name).read_text())
    return list(Draft202012Validator(schema).iter_errors(instance))


def write_workflow(tmp_path, workflow=None):
    workflow = workflow or workflow_contract()
    prompts = tmp_path / "prompts"
    prompts.mkdir(exist_ok=True)
    (prompts / "initial.md.tmpl").write_text("Implement {{inputs.prompt}}.\n")
    (prompts / "continuation.md.tmpl").write_text("Continue with {{run.issues-file}}.\n")
    path = tmp_path / "workflow.json"
    path.write_text(json.dumps(workflow))
    return path


def lint(path):
    result = run_command([BIN, "lint", str(path), "--format", "json"])
    payload = json.loads(result.stdout)
    return result, payload, {entry["code"] for entry in payload["diagnostics"]}


def test_resumable_session_shapes_are_owned_by_portable_schemas():
    workflow = workflow_contract()
    assert schema_errors("workflow.schema.json", workflow) == []

    missing_template = deepcopy(workflow)
    del missing_template["states"]["implement"]["session"]["continuation-prompt-template"]
    assert schema_errors("workflow.schema.json", missing_template)

    unknown_field = deepcopy(workflow)
    unknown_field["states"]["implement"]["session"]["guess-session"] = True
    assert schema_errors("workflow.schema.json", unknown_field)

    node_package = {
        "api-version": "tesseraft.node/v1",
        "kind": "node",
        "metadata": {"name": "resumable-node"},
        "node": deepcopy(workflow["states"]["implement"]),
    }
    assert schema_errors("node-package.schema.json", node_package) == []
    node_package["node"]["session"]["mode"] = "ambient"
    assert schema_errors("node-package.schema.json", node_package)

    fragment_package = {
        "api-version": "tesseraft.fragment/v1",
        "kind": "fragment",
        "metadata": {"name": "resumable-fragment"},
        "interface": {"outcomes": ["pass"]},
        "fragment": {
            "initial": "implement",
            "exit": [{"on": "pass"}],
            "states": {
                "implement": deepcopy(workflow["states"]["implement"]),
                "done": {"type": "terminal", "status": "success", "outcome": "pass"},
            },
        },
    }
    fragment_package["fragment"]["states"]["implement"]["transitions"] = [
        {"when": {"status": "pass"}, "next": "done"}
    ]
    assert schema_errors("fragment-package.schema.json", fragment_package) == []
    del fragment_package["fragment"]["states"]["implement"]["session"]["mode"]
    assert schema_errors("fragment-package.schema.json", fragment_package)


def test_json_workflow_normalizes_session_semantics_and_lints(tmp_path):
    result, payload, codes = lint(write_workflow(tmp_path))
    assert result.returncode == 0, result.stderr or result.stdout
    assert payload["ok"] is True
    assert codes == set()


def test_resumable_session_lint_diagnostics_are_explicit(tmp_path):
    cases = []

    unsupported = workflow_contract()
    unsupported["states"]["implement"]["executor"] = "opencode-cli"
    cases.append((unsupported, "resumable-session-unsupported-executor"))

    missing_template = workflow_contract()
    del missing_template["states"]["implement"]["session"]["continuation-prompt-template"]
    cases.append((missing_template, "session-missing-continuation-prompt-template"))

    unstamped_output = workflow_contract()
    unstamped_output["states"]["implement"]["outputs"]["status"]["path"] = "execution/status.json"
    cases.append((unstamped_output, "resumable-session-output-not-attempt-stamped"))

    unstamped_prompt = workflow_contract()
    unstamped_prompt["states"]["implement"]["session"]["continuation-prompt-output"] = "prompts/continuation.md"
    cases.append((unstamped_prompt, "session-continuation-prompt-output-not-attempt-stamped"))

    invalid_mode = workflow_contract()
    invalid_mode["states"]["implement"]["session"]["mode"] = "ambient"
    cases.append((invalid_mode, "invalid-session-mode"))

    unsafe_template = workflow_contract()
    unsafe_template["states"]["implement"]["session"]["continuation-prompt-template"] = "../outside.md"
    cases.append((unsafe_template, "invalid-session-continuation-prompt-path"))

    non_agent = workflow_contract()
    non_agent["states"]["done"]["session"] = deepcopy(
        non_agent["states"]["implement"]["session"]
    )
    cases.append((non_agent, "session-policy-requires-agent"))

    for index, (workflow, expected) in enumerate(cases):
        case_dir = tmp_path / str(index)
        case_dir.mkdir()
        result, payload, codes = lint(write_workflow(case_dir, workflow))
        assert result.returncode != 0, payload
        assert expected in codes, payload


def test_continuation_template_variables_and_node_export_are_in_contract(tmp_path):
    workflow = workflow_contract()
    path = write_workflow(tmp_path, workflow)
    (tmp_path / "prompts" / "continuation.md.tmpl").write_text(
        "Continue with {{hidden.feedback}}.\n"
    )
    result, payload, codes = lint(path)
    assert result.returncode != 0, payload
    assert "unknown-template-root" in codes

    fixture = ROOT / "test" / "fixtures" / "valid" / "resumable-session.workflow.edn"
    exported = tmp_path / "exported"
    export = run_command([BIN, "node", "export", str(fixture), "implement", "--out", str(exported)])
    assert export.returncode == 0, export.stderr or export.stdout
    assert (exported / "prompts" / "resumable-initial.md.tmpl").is_file()
    assert (exported / "prompts" / "resumable-continuation.md.tmpl").is_file()
    package = run_command([BIN, "node", "lint", str(exported / "node.edn"), "--strict", "--format", "json"])
    assert package.returncode == 0, package.stderr or package.stdout


def test_rs1_runtime_guard_fails_before_executor_invocation(workspace_layout):
    fixture = ROOT / "test" / "fixtures" / "valid" / "resumable-session.workflow.edn"
    started = run_command(
        [
            BIN,
            "run",
            "start",
            str(fixture),
            "--executor",
            "mock",
            "--run-id",
            "rs1-runtime-guard",
            "--workspace-root",
            str(workspace_layout.workspace),
            "--tesseraft-home",
            str(workspace_layout.home),
            "--input",
            "prompt=Do not execute",
            "--format",
            "json",
        ]
    )
    assert started.returncode == 0, started.stderr or started.stdout
    run_dir = Path(json.loads(started.stdout)["run"]["dir"])

    stepped = run_command([BIN, "run", "step", "--run-dir", str(run_dir), "--format", "json"])
    assert stepped.returncode != 0
    assert "Resumable session runtime is not implemented" in stepped.stderr

    events = read_json_lines(run_dir / "events.jsonl")
    assert [event["event"] for event in events][-2:] == ["node.started", "node.failed"]
    failure = events[-1]["result"]
    assert failure["error_type"] == "resumable_session_not_implemented"
    assert not list((run_dir / "prompts" / "generated").glob("*"))
