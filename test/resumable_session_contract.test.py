import json
import os
import shutil
import signal
import time
from copy import deepcopy
from pathlib import Path

from jsonschema import Draft202012Validator

from python_support import ROOT, read_json_lines, run_command, start_tesseraft


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


def copy_runtime_fixture(destination: Path) -> Path:
    source = ROOT / "test" / "fixtures" / "valid"
    workflow = destination / "workflow.edn"
    shutil.copy2(source / "resumable-runtime-review-loop.workflow.edn", workflow)
    (destination / "prompts").mkdir()
    for name in (
        "resumable-runtime-initial.md.tmpl",
        "resumable-runtime-continuation.md.tmpl",
    ):
        shutil.copy2(source / "prompts" / name, destination / "prompts" / name)
    (destination / "scripts").mkdir()
    shutil.copy2(
        source / "scripts" / "resumable-review.py",
        destination / "scripts" / "resumable-review.py",
    )
    return workflow


def wait_for(predicate, timeout=10.0, interval=0.05):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            if predicate():
                return True
        except (FileNotFoundError, json.JSONDecodeError, ValueError):
            pass
        time.sleep(interval)
    return False


def kill_pid(pid):
    try:
        os.kill(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


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


def test_resumable_mock_session_survives_process_restart_and_closes(workspace_layout):
    fixture = (
        ROOT
        / "test"
        / "fixtures"
        / "valid"
        / "resumable-runtime-review-loop.workflow.edn"
    )
    started = run_command(
        [
            BIN,
            "run",
            "start",
            str(fixture),
            "--executor",
            "mock",
            "--run-id",
            "resumable-runtime-loop",
            "--workspace-root",
            str(workspace_layout.workspace),
            "--tesseraft-home",
            str(workspace_layout.home),
            "--input",
            "prompt=Exercise resumable execution",
            "--format",
            "json",
        ]
    )
    assert started.returncode == 0, started.stderr or started.stdout
    run_dir = Path(json.loads(started.stdout)["run"]["dir"])

    first_process = run_command(
        [
            BIN,
            "run",
            "resume",
            "--run-dir",
            str(run_dir),
            "--max-steps",
            "2",
            "--format",
            "json",
        ]
    )
    assert first_process.returncode == 0, first_process.stderr or first_process.stdout
    first_run = json.loads(first_process.stdout)["run"]
    assert first_run["state"] == "implement"
    assert first_run["attempt"] == 3
    assert first_run["status"] == "running"

    binding_path = run_dir / "sessions" / "implement" / "binding.json"
    binding = json.loads(binding_path.read_text())
    assert schema_errors("session-binding.schema.json", binding) == []
    assert binding["status"] == "suspended"
    assert binding["activation_sequence"] == 1
    stable_ref = binding["session_ref"]

    second_process = run_command(
        [BIN, "run", "resume", "--run-dir", str(run_dir), "--format", "json"]
    )
    assert second_process.returncode == 0, second_process.stderr or second_process.stdout
    finished = json.loads(second_process.stdout)["run"]
    assert finished["status"] == "done"

    binding = json.loads(binding_path.read_text())
    assert schema_errors("session-binding.schema.json", binding) == []
    assert binding["status"] == "closed"
    assert binding["activation_sequence"] == 2
    assert binding["session_ref"] == stable_ref

    initial_prompt = run_dir / "prompts" / "generated" / "implement-initial-1.md"
    continuation_prompt = (
        run_dir / "prompts" / "generated" / "implement-continuation-3.md"
    )
    assert "Exercise resumable execution" in initial_prompt.read_text()
    assert "Continue the existing implementation" in continuation_prompt.read_text()
    assert "Exercise resumable execution" not in continuation_prompt.read_text()
    assert str(run_dir / "issues.json") in continuation_prompt.read_text()
    assert "tesseraft-delivery:" in initial_prompt.read_text()
    assert "tesseraft-delivery:" in continuation_prompt.read_text()

    assert (run_dir / "execution" / "implement-status-1.json").is_file()
    assert (run_dir / "execution" / "implement-status-3.json").is_file()
    assert json.loads((run_dir / "issues.json").read_text())[0]["source"] == "independent-review"

    events = read_json_lines(run_dir / "events.jsonl")
    session_events = [event["event"] for event in events if event["event"].startswith("session.")]
    assert session_events == [
        "session.allocated",
        "session.activation.started",
        "session.activation.finished",
        "session.suspended",
        "session.activation.started",
        "session.activation.finished",
        "session.suspended",
        "session.closed",
    ]
    assert stable_ref["value"] not in (run_dir / "events.jsonl").read_text()
    assert "SESSION_OPERATION: start" in (run_dir / "logs" / "implement-mock-1.log").read_text()
    assert "SESSION_OPERATION: resume" in (run_dir / "logs" / "implement-mock-3.log").read_text()


def test_resumable_session_rejects_configuration_drift_without_resuming(workspace_layout):
    workflow = copy_runtime_fixture(workspace_layout.workspace)
    started = run_command(
        [
            BIN,
            "run",
            "start",
            str(workflow),
            "--executor",
            "mock",
            "--run-id",
            "resumable-configuration-drift",
            "--workspace-root",
            str(workspace_layout.workspace),
            "--input",
            "prompt=Configuration drift",
            "--format",
            "json",
        ]
    )
    assert started.returncode == 0, started.stderr
    run_dir = Path(json.loads(started.stdout)["run"]["dir"])
    first = run_command(
        [
            BIN,
            "run",
            "resume",
            "--run-dir",
            str(run_dir),
            "--max-steps",
            "2",
            "--format",
            "json",
        ]
    )
    assert first.returncode == 0, first.stderr

    workflow.write_text(workflow.read_text().replace(":ls]", ":ls :grep]"))
    resumed = run_command(
        [BIN, "run", "resume", "--run-dir", str(run_dir), "--format", "json"]
    )
    assert resumed.returncode != 0
    assert "Resumable session configuration changed" in resumed.stderr

    binding = json.loads((run_dir / "sessions" / "implement" / "binding.json").read_text())
    assert binding["status"] == "suspended"
    assert binding["activation_sequence"] == 1
    events = read_json_lines(run_dir / "events.jsonl")
    assert len([e for e in events if e["event"] == "session.activation.started"]) == 1
    failed = [e for e in events if e["event"] == "node.failed"][-1]
    assert failed["result"]["error_type"] == "session_configuration_mismatch"


def test_pi_uses_one_exact_explicit_session_reference_for_start_and_resume(workspace_layout):
    workflow = copy_runtime_fixture(workspace_layout.workspace)
    argv_log = workspace_layout.logs / "pi-session-argv.jsonl"
    stub = workspace_layout.fixtures / "pi-session-stub.py"
    stub.write_text(
        '''#!/usr/bin/env python3
import json
import os
import pathlib
import sys

with pathlib.Path(os.environ["PI_SESSION_ARGV_LOG"]).open("a") as stream:
    stream.write(json.dumps(sys.argv[1:]) + "\\n")
run_dir = pathlib.Path(os.environ["AGENT_RUN_DIR"])
attempt = os.environ["AGENT_ATTEMPT"]
execution = run_dir / "execution"
execution.mkdir(parents=True, exist_ok=True)
(execution / f"implement-status-{attempt}.json").write_text(
    '{"status":"pass","summary":"fake Pi session","issues_file":null}\\n'
)
(execution / f"implement-summary-{attempt}.md").write_text("fake Pi summary\\n")
'''
    )
    stub.chmod(0o755)

    result = run_command(
        [
            BIN,
            "run",
            str(workflow),
            "--run-id",
            "resumable-pi-explicit-reference",
            "--workspace-root",
            str(workspace_layout.workspace),
            "--input",
            "prompt=Use one exact Pi session",
            "--format",
            "json",
        ],
        env={"PI_BIN": str(stub), "PI_SESSION_ARGV_LOG": str(argv_log)},
    )
    assert result.returncode == 0, result.stderr or result.stdout
    run_dir = Path(json.loads(result.stdout)["run"]["dir"])
    binding = json.loads((run_dir / "sessions" / "implement" / "binding.json").read_text())
    session_id = binding["session_ref"]["value"]
    calls = [json.loads(line) for line in argv_log.read_text().splitlines()]
    assert len(calls) == 2

    first, second = calls
    assert first[first.index("--session-id") + 1] == session_id
    assert second[second.index("--session") + 1] == session_id
    assert "--session" not in first
    assert "--session-id" not in second
    assert "--continue" not in first + second
    assert "--resume" not in first + second
    assert first[first.index("--session-dir") + 1] == str(run_dir / "pi-sessions")
    assert second[second.index("--session-dir") + 1] == str(run_dir / "pi-sessions")
    assert binding["status"] == "closed"
    assert binding["activation_sequence"] == 2
    assert session_id not in (run_dir / "events.jsonl").read_text()
    assert session_id not in (run_dir / "logs" / "implement-1.log").read_text()
    assert session_id not in (run_dir / "logs" / "implement-3.log").read_text()


def test_interrupted_session_with_complete_outputs_recovers_without_redelivery(workspace_layout):
    workflow = copy_runtime_fixture(workspace_layout.workspace)
    calls = workspace_layout.logs / "recovering-pi-calls.txt"
    child_pid = workspace_layout.logs / "recovering-pi.pid"
    stub = workspace_layout.fixtures / "recovering-pi.py"
    stub.write_text(
        '''#!/usr/bin/env python3
import os
import pathlib
import time

run_dir = pathlib.Path(os.environ["AGENT_RUN_DIR"])
attempt = os.environ["AGENT_ATTEMPT"]
with pathlib.Path(os.environ["PI_RECOVERY_CALLS"]).open("a") as stream:
    stream.write(attempt + "\\n")
execution = run_dir / "execution"
execution.mkdir(parents=True, exist_ok=True)
(execution / f"implement-status-{attempt}.json").write_text(
    '{"status":"pass","summary":"completed before interruption","issues_file":null}\\n'
)
(execution / f"implement-summary-{attempt}.md").write_text("completed before interruption\\n")
pathlib.Path(os.environ["PI_RECOVERY_PID"]).write_text(str(os.getpid()))
time.sleep(300)
'''
    )
    stub.chmod(0o755)
    env = {
        "PI_BIN": str(stub),
        "PI_RECOVERY_CALLS": str(calls),
        "PI_RECOVERY_PID": str(child_pid),
    }
    started = run_command(
        [
            BIN,
            "run",
            "start",
            str(workflow),
            "--run-id",
            "resumable-output-recovery",
            "--workspace-root",
            str(workspace_layout.workspace),
            "--input",
            "prompt=Recover without redelivery",
            "--format",
            "json",
        ],
        env=env,
    )
    assert started.returncode == 0, started.stderr
    run_dir = Path(json.loads(started.stdout)["run"]["dir"])
    binding_path = run_dir / "sessions" / "implement" / "binding.json"
    process = start_tesseraft(
        [
            "run",
            "resume",
            "--run-dir",
            str(run_dir),
            "--max-steps",
            "1",
            "--format",
            "json",
        ],
        workspace_layout.home,
        env,
    )
    child = None
    try:
        assert wait_for(
            lambda: child_pid.exists()
            and json.loads(binding_path.read_text())["status"] == "active"
        )
        child = int(child_pid.read_text())
        process.kill()
        process.wait(timeout=5)
        kill_pid(child)

        recovered = run_command(
            [
                BIN,
                "run",
                "resume",
                "--run-dir",
                str(run_dir),
                "--max-steps",
                "1",
                "--format",
                "json",
            ],
            env=env,
        )
        assert recovered.returncode == 0, recovered.stderr or recovered.stdout
        assert json.loads(recovered.stdout)["run"]["state"] == "review"
        assert calls.read_text().splitlines() == ["1"]
        binding = json.loads(binding_path.read_text())
        assert binding["status"] == "suspended"
        assert binding["last_activation"]["recovered"] is True
        events = read_json_lines(run_dir / "events.jsonl")
        assert any(event["event"] == "node.recovered" for event in events)
        assert any(
            event["event"] == "session.activation.finished" and event.get("recovered")
            for event in events
        )
        assert not any(event["event"] == "session.orphaned" for event in events)
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        if child is not None:
            kill_pid(child)


def test_interrupted_session_without_proof_is_orphaned_and_never_redelivered(workspace_layout):
    workflow = copy_runtime_fixture(workspace_layout.workspace)
    calls = workspace_layout.logs / "orphaned-pi-calls.txt"
    child_pid = workspace_layout.logs / "orphaned-pi.pid"
    stub = workspace_layout.fixtures / "orphaned-pi.py"
    stub.write_text(
        '''#!/usr/bin/env python3
import os
import pathlib
import time

with pathlib.Path(os.environ["PI_ORPHAN_CALLS"]).open("a") as stream:
    stream.write(os.environ["AGENT_ATTEMPT"] + "\\n")
pathlib.Path(os.environ["PI_ORPHAN_PID"]).write_text(str(os.getpid()))
time.sleep(300)
'''
    )
    stub.chmod(0o755)
    env = {
        "PI_BIN": str(stub),
        "PI_ORPHAN_CALLS": str(calls),
        "PI_ORPHAN_PID": str(child_pid),
    }
    started = run_command(
        [
            BIN,
            "run",
            "start",
            str(workflow),
            "--run-id",
            "resumable-orphan",
            "--workspace-root",
            str(workspace_layout.workspace),
            "--input",
            "prompt=Do not redeliver an ambiguous prompt",
            "--format",
            "json",
        ],
        env=env,
    )
    assert started.returncode == 0, started.stderr
    run_dir = Path(json.loads(started.stdout)["run"]["dir"])
    binding_path = run_dir / "sessions" / "implement" / "binding.json"
    process = start_tesseraft(
        [
            "run",
            "resume",
            "--run-dir",
            str(run_dir),
            "--max-steps",
            "1",
            "--format",
            "json",
        ],
        workspace_layout.home,
        env,
    )
    child = None
    try:
        assert wait_for(
            lambda: child_pid.exists()
            and json.loads(binding_path.read_text())["status"] == "active"
        )
        child = int(child_pid.read_text())
        process.kill()
        process.wait(timeout=5)
        kill_pid(child)

        resumed = run_command(
            [
                BIN,
                "run",
                "resume",
                "--run-dir",
                str(run_dir),
                "--max-steps",
                "1",
                "--format",
                "json",
            ],
            env=env,
        )
        assert resumed.returncode != 0
        assert "Orphaned node detected" in resumed.stderr
        assert calls.read_text().splitlines() == ["1"]
        binding = json.loads(binding_path.read_text())
        assert binding["status"] == "orphaned"
        assert binding["last_activation"]["error_type"] == "session_activation_interrupted"
        events = read_json_lines(run_dir / "events.jsonl")
        assert [event["event"] for event in events][-2:] == [
            "session.orphaned",
            "node.orphaned",
        ]
    finally:
        if process.poll() is None:
            process.kill()
            process.wait(timeout=5)
        if child is not None:
            kill_pid(child)
