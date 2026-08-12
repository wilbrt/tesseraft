import json
import re
from pathlib import Path

from python_support import ROOT, read_json_lines, run_command, run_control_plane, run_tesseraft


BIN = str(ROOT / "bin" / "tesseraft")


def write_executable(path: Path, text: str) -> None:
    path.write_text(text)
    path.chmod(0o755)


def test_agent_provider_model_and_thinking_reach_pi_and_durable_log(workspace_layout):
    workspace = workspace_layout.workspace
    prompt_dir = workspace / "prompts"
    prompt_dir.mkdir()
    (prompt_dir / "agent.md.tmpl").write_text("Write the status artifact.\n")
    workflow = workspace / "agent-model-provider.workflow.edn"
    workflow.write_text('''{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {:name "agent-model-provider-fixture"}
 :defaults {:max-rounds 1 :state-timeout "1m"}
 :policies {:require-timeouts true :require-max-rounds true}
 :initial :agent
 :states {:agent {:type :agent
                  :executor :pi-cli
                  :provider "opencode-go"
                  :model "kimi-k3"
                  :thinking "medium"
                  :prompt-template "prompts/agent.md.tmpl"
                  :runtime {:cwd "." :timeout "10s"}
                  :outputs {:status {:path "agent/status.json" :required true}}
                  :next :done}
          :done {:type :terminal :status :success}}}
''')
    invalid = workspace / "agent-model-provider-invalid.workflow.edn"
    invalid.write_text(
        workflow.read_text()
        .replace(':provider "opencode-go"', ':provider ""')
        .replace(':model "kimi-k3"', ':model 123')
        .replace(':thinking "medium"', ':thinking "maximum"')
    )
    lint = run_command([BIN, "lint", str(workflow), "--format", "json"])
    assert lint.returncode == 0, lint.stderr
    invalid_lint = run_command([BIN, "lint", str(invalid), "--format", "json"])
    assert invalid_lint.returncode != 0
    for code in ("invalid-agent-provider", "invalid-agent-model", "invalid-agent-thinking"):
        assert code in invalid_lint.stdout

    argv_path = workspace_layout.logs / "pi-argv.txt"
    stub = workspace_layout.fixtures / "pi-stub.py"
    write_executable(stub, '''#!/usr/bin/env python3
import os, pathlib, sys
pathlib.Path(os.environ["AGENT_MODEL_ARGV"]).write_text("\\n".join(sys.argv[1:]) + "\\n")
run_dir = pathlib.Path(os.environ["AGENT_RUN_DIR"])
(run_dir / "agent").mkdir(parents=True, exist_ok=True)
(run_dir / "agent/status.json").write_text('{"status":"pass","summary":"stubbed pi","issues_file":null}\\n')
''')
    result = run_tesseraft(
        ["run", str(workflow), "--run-id", "agent-model-provider-test",
         "--workspace-root", str(workspace), "--format", "json"],
        workspace_layout.home,
        {"PI_BIN": str(stub), "AGENT_MODEL_ARGV": str(argv_path)},
    )
    assert result.returncode == 0, result.stderr
    body = json.loads(result.stdout)
    run_dir = Path(body["run"]["dir"])
    argv = argv_path.read_text().splitlines()
    # Authentication belongs to Pi. In particular, Tesseraft must invoke Pi
    # when OpenCode Go is stored by /login and OPENCODE_API_KEY is unset.
    assert argv[argv.index("--provider") + 1] == "opencode-go"
    assert argv[argv.index("--model") + 1] == "kimi-k3"
    assert argv[argv.index("--thinking") + 1] == "medium"
    log = (run_dir / "logs/agent-1.log").read_text()
    assert "PROVIDER: opencode-go" in log
    assert "MODEL: kimi-k3" in log
    assert "THINKING: medium" in log


def test_git_user_identity_is_persisted_injected_and_mutually_required(workspace_layout):
    workspace = workspace_layout.workspace
    prompt = workspace / "git-user-prompt.md.tmpl"
    prompt.write_text("Git user fixture prompt.\n")
    workflow = workspace / "git-user.workflow.edn"
    workflow.write_text('''{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {:name "git-user-fixture"}
 :defaults {:max-rounds 1 :state-timeout "1m"}
 :policies {:require-timeouts true :require-max-rounds true}
 :initial :agent
 :states {:agent {:type :agent
                  :executor :pi-cli
                  :prompt-template "git-user-prompt.md.tmpl"
                  :runtime {:timeout "1m"}
                  :outputs {:status {:path "agent/status.json" :required true}}
                  :next :done}
          :done {:type :terminal :status :success}}}
''')
    env_path = workspace_layout.logs / "git-env.txt"
    stub = workspace_layout.fixtures / "pi-git-user-stub.py"
    write_executable(stub, '''#!/usr/bin/env python3
import os, pathlib
keys = ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "GIT_USER_NAME", "GIT_USER_EMAIL"]
pathlib.Path(os.environ["GIT_USER_ENV_PATH"]).write_text("".join(f"{key}={os.environ[key]}\\n" for key in keys))
run_dir = pathlib.Path(os.environ["AGENT_RUN_DIR"])
(run_dir / "agent").mkdir(parents=True, exist_ok=True)
(run_dir / "agent/status.json").write_text('{"status":"pass","summary":"stubbed git-user pi","issues_file":null}\\n')
''')
    result = run_tesseraft(
        ["run", str(workflow), "--run-id", "git-user-test",
         "--workspace-root", str(workspace),
         "--git-user-name", "Ada Lovelace", "--git-user-email", "ada@example.com",
         "--format", "json"],
        workspace_layout.home,
        {"PI_BIN": str(stub), "GIT_USER_ENV_PATH": str(env_path)},
    )
    assert result.returncode == 0, result.stderr
    run_dir = Path(json.loads(result.stdout)["run"]["dir"])
    state = (run_dir / "state.edn").read_text()
    assert re.search(r':git-user\s*\{[^}]*:name\s*"Ada Lovelace"[^}]*:email\s*"ada@example.com"', state)
    environment = env_path.read_text()
    for key in ("GIT_AUTHOR_NAME", "GIT_COMMITTER_NAME", "GIT_USER_NAME"):
        assert f"{key}=Ada Lovelace" in environment
    for key in ("GIT_AUTHOR_EMAIL", "GIT_COMMITTER_EMAIL", "GIT_USER_EMAIL"):
        assert f"{key}=ada@example.com" in environment

    partial = run_tesseraft(
        ["run", "start", str(workflow), "--run-id", "git-user-partial",
         "--workspace-root", str(workspace), "--git-user-name", "Only", "--format", "json"],
        workspace_layout.home,
    )
    assert partial.returncode != 0
    assert "requires --git-user-email" in partial.stderr


def test_preexisting_agent_artifact_recovers_without_executor(workspace_layout):
    workspace = workspace_layout.workspace
    (workspace / "recovery-prompt.md.tmpl").write_text("Recovery fixture prompt.\n")
    workflow = workspace / "recovery.workflow.edn"
    workflow.write_text('''{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {:name "recovery-fixture"}
 :defaults {:max-rounds 1 :state-timeout "1m"}
 :policies {:require-timeouts true :require-max-rounds true}
 :initial :agent
 :states {:agent {:type :agent
                  :executor :pi-cli
                  :prompt-template "recovery-prompt.md.tmpl"
                  :runtime {:timeout "1m"}
                  :outputs {:status {:path "agent/status.json" :required true}}
                  :next :done}
          :done {:type :terminal :status :success}}}
''')
    started = run_tesseraft(
        ["run", "start", str(workflow), "--run-id", "recovery-test",
         "--workspace-root", str(workspace), "--format", "json"],
        workspace_layout.home,
    )
    assert started.returncode == 0, started.stderr
    run_dir = Path(json.loads(started.stdout)["run"]["dir"])
    (run_dir / "agent").mkdir()
    (run_dir / "agent/status.json").write_text(
        '{"status":"ok","summary":"preexisting completed artifact","issues_file":null}\n'
    )
    stepped = run_tesseraft(["run", "step", "--run-dir", str(run_dir), "--format", "json"], workspace_layout.home)
    assert stepped.returncode == 0, stepped.stderr
    assert json.loads(stepped.stdout)["run"]["status"] == "done"
    assert any(event.get("event") == "node.recovered" for event in read_json_lines(run_dir / "events.jsonl"))


def test_process_failure_has_durable_and_control_plane_evidence(workspace_layout):
    workflow = workspace_layout.workspace / "process-failure.workflow.edn"
    workflow.write_text('''{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {:name "process-failure-fixture"}
 :defaults {:max-rounds 1 :state-timeout "1m"}
 :policies {:require-timeouts true :require-max-rounds true}
 :initial :boom
 :states {:boom {:type :process
                 :command ["bash" "-lc" "echo external failure >&2; exit 7"]
                 :runtime {:timeout "10s"}
                 :next :done}
          :done {:type :terminal :status :success}}}
''')
    started = run_tesseraft(
        ["run", "start", str(workflow), "--run-id", "process-failure-test",
         "--workspace-root", str(workspace_layout.workspace), "--format", "json"],
        workspace_layout.home,
    )
    assert started.returncode == 0, started.stderr
    run_dir = Path(json.loads(started.stdout)["run"]["dir"])
    step = run_tesseraft(["run", "step", "--run-dir", str(run_dir), "--format", "json"], workspace_layout.home)
    assert step.returncode != 0
    assert ':status "failed"' in (run_dir / "state.edn").read_text()
    events = read_json_lines(run_dir / "events.jsonl")
    assert any(event.get("event") == "node.started" for event in events)
    failed = [event for event in events if event.get("event") == "node.failed"]
    assert len(failed) == 1
    result = failed[0]["result"]
    assert result["status"] == "error" and result["ok"] is False
    assert result.get("exit-code", result.get("exit_code")) == 7
    assert Path(result.get("log-file", result.get("log_file"))).exists()

    resolved = run_control_plane(
        ["--workspace-root", str(workspace_layout.workspace), "run", "process-failure-test"],
        workspace_layout.home,
    )
    assert resolved.returncode == 0, resolved.stderr
    run = json.loads(resolved.stdout)["run"]
    assert run["status"] == "failed"
    assert any(attempt["status"] == "error" and attempt["node_id"] == "boom" for attempt in run["attempts"])
    assert any(failure["source"] == "attempt" and failure.get("node_id") == "boom" for failure in run["failures"])


def test_control_plane_workflow_run_doctor_and_scope_contracts(workspace_layout):
    workspace = workspace_layout.workspace
    home = workspace_layout.home
    workflow_root = ROOT / "examples"
    started = run_tesseraft(
        ["run", str(ROOT / "examples/tutorials/smoke/workflow.edn"), "--run-id", "smoke-test",
         "--workspace-root", str(workspace), "--format", "json"],
        home,
    )
    assert started.returncode == 0, started.stderr
    base_args = ["--workspace-root", str(workspace), "--workflow-root", str(workflow_root)]
    workflows = run_control_plane([*base_args, "workflows"], home)
    assert workflows.returncode == 0, workflows.stderr
    assert any(item["name"] == "smoke-demo" for item in json.loads(workflows.stdout)["workflows"])

    graph = run_control_plane([*base_args, "graph", "smoke-demo"], home)
    graph_body = json.loads(graph.stdout)
    assert graph_body["workflow_name"] == "smoke-demo"
    assert any(node["id"] == "start" for node in graph_body["nodes"])
    assert any(edge["from"] == "start" and edge["to"] == "done" for edge in graph_body["edges"])
    run = json.loads(run_control_plane([*base_args, "run", "smoke-test"], home).stdout)["run"]
    assert run["run_id"] == "smoke-test" and run["status"] == "done"
    assert run["links"]["events"] == "/runs/smoke-test/events"
    events = json.loads(run_control_plane([*base_args, "events", "smoke-test"], home).stdout)
    assert any(event["event"] == "run.finished" for event in events["events"])

    doctor = run_control_plane([*base_args, "doctor"], home)
    doctor_body = json.loads(doctor.stdout)
    assert doctor_body["project_id"] == "default"
    assert set(doctor_body["summary"]) == {"ready", "not-configured", "unreachable", "invalid"}
    assert [check["id"] for check in doctor_body["checks"]] == [
        "code-host-credential", "code-host-auth", "pi-provider-model", "git-author",
        "repository-root", "pinga",
        "workflow-discovery", "runs-root", "work-tracker-config", "work-tracker-credential",
    ]
    assert all(check["status"] in {"ready", "not-configured", "unreachable", "invalid"}
               for check in doctor_body["checks"])
    assert doctor_body["work_tracker"]["state"] == "absent"
    assert "SECRET_SENTINEL" not in doctor.stdout

    project_workflow = workspace / ".tesseraft" / "workflows" / "shared" / "workflow.edn"
    global_workflow = home / "workflows" / "shared" / "workflow.edn"
    configured_root = workspace_layout.fixtures / "examples"
    configured_workflow = configured_root / "shared" / "workflow.edn"
    text = '{:api-version "tesseraft.workflow/v1" :kind :workflow :metadata {:name "scope-shadow-demo"} :initial :done :states {:done {:type :terminal}}}\n'
    for path in (project_workflow, global_workflow, configured_workflow):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)
    scoped_args = ["--workspace-root", str(workspace), "--workflow-root", str(configured_root)]
    scoped = json.loads(run_control_plane([*scoped_args, "workflows"], home).stdout)
    matches = [workflow for workflow in scoped["workflows"] if workflow["name"] == "scope-shadow-demo"]
    assert len(matches) == 1
    selected = matches[0]
    assert selected["source"] == "project" and selected["precedence"] == 200
    assert sorted(item["scope"] for item in selected["duplicates"]) == ["configured", "global"]
    assert all(item["precedence"] < 200 for item in selected["duplicates"])
    detail = json.loads(run_control_plane([*scoped_args, "workflow", "scope-shadow-demo"], home).stdout)
    assert "precedence" in detail["workflow"]
    assert "duplicates" in detail["workflow"]
