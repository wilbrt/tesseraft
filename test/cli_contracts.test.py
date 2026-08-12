import json
import os
import shutil
from pathlib import Path

import pytest

from python_support import ROOT, read_json_lines, run_command, run_tesseraft


BIN = str(ROOT / "bin" / "tesseraft")


MAINTAINED_WORKFLOWS = [
    "examples/tutorials/smoke/workflow.edn",
    "examples/catalog/prompt-to-pr/workflow.edn",
    "examples/catalog/worktree-to-pr/workflow.edn",
    "examples/catalog/code-review-loop/workflow.edn",
    "examples/catalog/playwright-code-review-loop/workflow.edn",
    "examples/catalog/deterministic-code-review-loop/workflow.edn",
    "examples/catalog/supervised-deterministic-code-review-loop/workflow.edn",
    "examples/catalog/design-in-practice-to-pr/workflow.edn",
    "examples/catalog/canon-tdd-to-pr/workflow.edn",
    "examples/catalog/focused-tdd-to-pr/workflow.edn",
    "examples/catalog/pr-housekeeping/workflow.edn",
    "examples/catalog/work-item-to-pr/workflow.edn",
]


@pytest.mark.parametrize("relative", MAINTAINED_WORKFLOWS)
def test_maintained_workflows_lint(relative):
    args = [BIN, "lint", relative, "--format", "json"]
    if relative == "examples/catalog/design-in-practice-to-pr/workflow.edn":
        args.append("--strict")
    result = run_command(args)
    assert result.returncode == 0, result.stderr or result.stdout
    assert json.loads(result.stdout)["ok"] is True


def test_every_valid_fixture_manifest_lints():
    manifests = sorted((ROOT / "test" / "fixtures" / "valid").rglob("*.edn"))
    manifests = [
        path for path in manifests
        if path.name in {"node.edn", "fragment.edn"} or path.name.endswith(".workflow.edn")
    ]
    assert manifests
    for path in manifests:
        if path.name == "node.edn":
            args = [BIN, "node", "lint", str(path), "--format", "json"]
        elif path.name == "fragment.edn":
            args = [BIN, "fragment", "lint", str(path), "--format", "json"]
        else:
            args = [BIN, "lint", str(path), "--format", "json"]
        result = run_command(args)
        assert result.returncode == 0, f"{path}: {result.stderr or result.stdout}"
        assert json.loads(result.stdout)["ok"] is True, path


INVALID_FRAGMENTS = [
    ("fragment-missing-exit-fragment", "fragment-outcome-mismatch", ["fragment", "exit"]),
    ("fragment-duplicate-exit", "duplicate-exit", ["fragment", "exit"]),
    ("fragment-missing-outcomes", "fragment-outcome-mismatch", ["interface", "outcomes"]),
    ("fragment-terminal-missing-outcome", "fragment-terminal-missing-outcome", ["fragment", "states", "done", "outcome"]),
    ("fragment-terminal-unknown-outcome", "fragment-terminal-unknown-outcome", ["fragment", "states", "done", "outcome"]),
    ("fragment-terminal-multi-outcome", "fragment-terminal-ambiguous-outcome", ["fragment", "states", "done", "outcome"]),
    ("fragment-unreachable-outcome", "fragment-unreachable-outcome", ["interface", "outcomes"]),
    ("fragment-nested-fragment", "nested-fragment", ["fragment", "states", "run-tests", "type"]),
    ("fragment-unreachable-nested-fragment", "nested-fragment", ["fragment", "states", "unreachable-child", "type"]),
    ("fragment-unsafe-asset", "invalid-asset-path", None),
    ("fragment-exit-unsafe-produces", "fragment-exit-invalid-produces-path", None),
    ("fragment-missing-required-input", "fragment-missing-interface", None),
    ("fragment-no-terminal", "missing-terminal-state", None),
    ("fragment-missing-prompt", "agent-missing-prompt-template", None),
    ("fragment-bad-template-var", "unknown-template-root", None),
]


def assert_diagnostic(payload, code, expected_path=None, collection="errors"):
    matches = [entry for entry in payload.get(collection, []) if entry.get("code") == code]
    if expected_path is not None:
        matches = [entry for entry in matches if entry.get("path") == expected_path]
    assert matches, json.dumps(payload, indent=2)


@pytest.mark.parametrize("fixture,code,expected_path", INVALID_FRAGMENTS)
@pytest.mark.parametrize("strict", [False, True])
def test_invalid_fragment_diagnostics_are_stable(fixture, code, expected_path, strict):
    path = ROOT / "test" / "fixtures" / "invalid" / fixture / "fragment.edn"
    args = [BIN, "fragment", "lint", str(path), "--format", "json"]
    if strict:
        args.append("--strict")
    result = run_command(args)
    assert result.returncode != 0, result.stdout
    assert_diagnostic(json.loads(result.stdout), code, expected_path)


@pytest.mark.parametrize(
    "fixture,code",
    [
        ("resource-missing-producer", "resource-missing-producer"),
        ("resource-read-consume-missing-producer", "resource-missing-producer"),
        ("resource-branch-missing-producer", "resource-missing-producer"),
        ("resource-double-consume", "resource-double-consume"),
        ("resource-undeclared-input", "resource-missing-producer"),
        ("resource-ambient-path-mismatch", "resource-missing-producer"),
        ("resource-cycle-conservative", "resource-cycle-conservative"),
    ],
)
def test_invalid_resource_flow_diagnostics_are_stable(fixture, code):
    path = ROOT / "test" / "fixtures" / "invalid" / f"{fixture}.workflow.edn"
    result = run_command([BIN, "lint", str(path), "--format", "json"])
    assert result.returncode != 0, result.stdout
    assert code in result.stdout


@pytest.mark.parametrize(
    "fixture,code",
    [
        ("fragment-missing-input", "fragment-input-binding-missing"),
        ("fragment-unknown-outcome", "fragment-unknown-outcome"),
    ],
)
@pytest.mark.parametrize("strict", [False, True])
def test_invalid_fragment_workflow_diagnostics_are_stable(fixture, code, strict):
    path = ROOT / "test" / "fixtures" / "invalid" / f"{fixture}.workflow.edn"
    args = [BIN, "lint", str(path), "--format", "json"]
    if strict:
        args.append("--strict")
    result = run_command(args)
    assert result.returncode != 0, result.stdout
    assert_diagnostic(json.loads(result.stdout), code)


def test_warning_only_fragment_contracts_fail_only_under_strict_lint():
    uncovered = ROOT / "test" / "fixtures" / "invalid" / "fragment-uncovered-outcome.workflow.edn"
    normal = run_command([BIN, "lint", str(uncovered), "--format", "json"])
    assert normal.returncode == 0, normal.stdout
    assert_diagnostic(json.loads(normal.stdout), "fragment-uncovered-outcome", collection="warnings")
    strict = run_command([BIN, "lint", str(uncovered), "--strict", "--format", "json"])
    assert strict.returncode != 0
    assert_diagnostic(json.loads(strict.stdout), "fragment-uncovered-outcome")

    cycle = ROOT / "test" / "fixtures" / "invalid" / "fragment-unbounded-cycle" / "fragment.edn"
    strict_cycle = run_command([BIN, "fragment", "lint", str(cycle), "--strict", "--format", "json"])
    assert strict_cycle.returncode != 0
    assert_diagnostic(json.loads(strict_cycle.stdout), "cycle-without-explicit-limit")


@pytest.mark.parametrize(
    "args,expected_codes,require_all",
    [
        (["lint", "test/fixtures/invalid/missing-prompt.workflow.edn", "--format", "json"],
         {"prompt-template-missing"}, True),
        (["lint", "test/fixtures/invalid/malformed-resources.workflow.edn", "--format", "json"],
         {"resource-group-not-vector", "resource-missing-name", "resource-unknown-field", "invalid-resource-path"}, False),
        (["lint", "test/fixtures/invalid/resource-warnings.workflow.edn", "--strict", "--format", "json"],
         {"resource-unknown-mode", "duplicate-resource-declaration"}, True),
        (["node", "lint", "test/fixtures/invalid/missing-node-asset/node.edn", "--format", "json"],
         {"asset-missing", "prompt-template-missing"}, False),
        (["node", "lint", "test/fixtures/invalid/malformed-resource-node/node.edn", "--format", "json"],
         {"resource-not-map"}, True),
        (["node", "lint", "test/fixtures/invalid/resource-warning-node/node.edn", "--strict", "--format", "json"],
         {"resource-unknown-mode", "duplicate-resource-declaration"}, True),
    ],
)
def test_invalid_workflow_and_node_fixtures_report_expected_diagnostics(args, expected_codes, require_all):
    result = run_command([BIN, *args])
    assert result.returncode != 0, result.stdout
    payload = json.loads(result.stdout)
    actual_codes = {entry["code"] for entry in payload["diagnostics"]}
    if require_all:
        assert expected_codes <= actual_codes, payload
    else:
        assert expected_codes & actual_codes, payload


@pytest.mark.parametrize(
    "args,message",
    [
        ([BIN, "lint", "examples/tutorials/smoke/workflow.edn", "--format"], "Missing value for --format"),
        ([str(ROOT / "bin" / "tesseraft-lint"), "examples/tutorials/smoke/workflow.edn", "--emit"], "Missing value for --emit"),
        ([BIN, "run", "examples/tutorials/smoke/workflow.edn", "--run-id"], "Missing value for --run-id"),
        ([str(ROOT / "bin" / "tesseraft-run"), "examples/tutorials/smoke/workflow.edn", "--format"], "Missing value for --format"),
    ],
)
def test_missing_cli_values_are_clean_usage_errors(args, message):
    result = run_command(args)
    output = result.stderr + result.stdout
    assert result.returncode == 2, output
    assert message in output
    assert "Stack trace" not in output
    assert "ExceptionInfo" not in output


def test_version_and_provider_listing_are_stable_and_secret_free():
    version = run_command([BIN, "--version"])
    assert version.returncode == 0
    assert version.stdout.strip() == "tesseraft 0.1.0"
    providers = run_command([BIN, "control-plane", "project", "work-tracker-providers"])
    assert providers.returncode == 0, providers.stderr
    payload = json.loads(providers.stdout)
    assert [provider["provider"] for provider in payload["providers"]] == ["github-issues", "jira", "plane"]
    assert "SECRET_SENTINEL" not in providers.stdout


def test_launcher_exposes_bundled_pi_without_a_global_install(tmp_path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    for command in ("bash", "dirname", "awk", "bb"):
        executable = shutil.which(command)
        assert executable, f"{command} is required for this contract test"
        (fake_bin / command).symlink_to(executable)

    result = run_command(
        [BIN, "control-plane", "capabilities"],
        env={"PATH": str(fake_bin)},
    )

    assert result.returncode == 0, result.stderr or result.stdout
    payload = json.loads(result.stdout)
    pi = next(executor for executor in payload["executors"] if executor["id"] == "pi-cli")
    assert pi["availability"] == {"status": "ready", "executable": "pi"}


def test_dependency_doctor_rejects_unknown_profiles_with_clean_usage():
    result = run_command([BIN, "doctor", "--profile", "unknown"])
    assert result.returncode == 2
    assert "core|web|workflow|test|e2e" in result.stderr
    assert "Stack trace" not in result.stderr


@pytest.mark.parametrize(
    ("version", "accepted"),
    [("1.12.218", True), ("1.13.219", True), ("1.12.217", False), ("2.0.0", False)],
)
def test_core_dependency_doctor_accepts_newer_same_major_babashka(tmp_path, version, accepted):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    bb = fake_bin / "bb"
    bb.write_text(f'#!/bin/sh\nprintf "babashka v{version}\\n"\n')
    bb.chmod(0o755)

    result = run_command(
        [BIN, "doctor", "--profile", "core"],
        env={"PATH": f"{fake_bin}:{os.environ['PATH']}"},
    )
    assert (result.returncode == 0) is accepted, result.stderr or result.stdout
    if version == "1.13.219":
        assert "compatible; pinned baseline 1.12.218" in result.stdout


def test_test_dependency_doctor_keeps_exact_babashka_pin(tmp_path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    versions = {
        "bb": "babashka v1.13.219",
        "node": "v22.23.2",
        "npm": "11.18.0",
        "python3": "3.11",
    }
    for command, version in versions.items():
        executable = fake_bin / command
        executable.write_text(f'#!/bin/sh\nprintf "{version}\\n"\n')
        executable.chmod(0o755)

    result = run_command(
        [BIN, "doctor", "--profile", "test"],
        env={"PATH": f"{fake_bin}:{os.environ['PATH']}"},
    )
    assert result.returncode == 1
    assert "bb expected 1.12.218, found 1.13.219" in result.stderr


def test_workflow_dependency_doctor_accepts_supported_python_and_checks_commands(tmp_path):
    fake_bin = tmp_path / "bin"
    fake_bin.mkdir()
    versions = {
        "bb": "babashka v1.12.218",
        "node": "v22.23.2",
        "npm": "11.18.0",
        "python3": "3.12",
    }
    for command, version in versions.items():
        executable = fake_bin / command
        executable.write_text(f'#!/bin/sh\nprintf "{version}\\n"\n')
        executable.chmod(0o755)
    for command in ("git", "gh"):
        executable = fake_bin / command
        executable.write_text("#!/bin/sh\nexit 0\n")
        executable.chmod(0o755)

    result = run_command(
        [BIN, "doctor", "--profile", "workflow"],
        env={"PATH": f"{fake_bin}:{os.environ['PATH']}"},
    )

    assert result.returncode == 0, result.stderr or result.stdout
    assert "python3 3.12" in result.stdout
    assert "compatible; pinned baseline 3.11" in result.stdout
    assert "ok: gh" in result.stdout
    assert "ok: pi" in result.stdout


def test_installers_expose_python_and_wsl_bootstrap_contracts():
    generic = run_command([str(ROOT / "scripts" / "install.sh"), "--help"])
    assert generic.returncode == 0, generic.stderr
    assert "Python" in generic.stdout
    assert "--install-deps" in generic.stdout

    wsl = run_command([str(ROOT / "scripts" / "install-wsl.sh"), "--help"])
    assert wsl.returncode == 0, wsl.stderr
    assert "GitHub CLI" in wsl.stdout
    assert "including Pi" in wsl.stdout


def test_node_and_fragment_export_import_round_trip(workspace_layout):
    node_out = workspace_layout.fixtures / "exported-start"
    exported = run_command([
        BIN, "node", "export", "examples/tutorials/smoke/workflow.edn", "start", "--out", str(node_out)
    ])
    assert exported.returncode == 0, exported.stderr
    assert run_command([BIN, "node", "lint", str(node_out / "node.edn")]).returncode == 0

    project = workspace_layout.workspace
    package = project / ".tesseraft" / "fragments" / "test-fix-loop"
    shutil.copytree(ROOT / "examples" / "catalog" / "fragments" / "test-fix-loop", package)
    workflow = project / "workflow.edn"
    workflow.write_text('''{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {:name "fragment-import-target"}
 :inputs {:repo-root {:type :string :required true}
          :test-cmd {:type :string :required true}}
 :defaults {:max-rounds 3 :state-timeout "10m"}
 :policies {:require-timeouts true :require-max-rounds true}
 :initial :run-tests
 :states {:done {:type :terminal :status :success}}}
''')
    imported = run_command(
        [BIN, "fragment", "import", str(package / "fragment.edn"), str(workflow),
         "--as", "run-tests", "--input", 'repo-root="{{inputs.repo-root}}"',
         "--input", 'test-cmd="{{inputs.test-cmd}}"', "--next", "done"],
        env={"TESSERAFT_HOME": str(workspace_layout.home)},
    )
    assert imported.returncode == 0, imported.stderr
    text = workflow.read_text()
    assert ":run-tests" in text
    assert ":type :fragment" in text
    assert ':fragment "test-fix-loop"' in text
    assert run_command([BIN, "lint", str(workflow), "--strict"]).returncode == 0
    fragment_example = ROOT / "examples" / "catalog" / "fragments" / "test-fix-loop" / "fragment.edn"
    fragment_lint = run_command([BIN, "fragment", "lint", str(fragment_example), "--format", "json"])
    assert fragment_lint.returncode == 0, fragment_lint.stderr
    assert json.loads(fragment_lint.stdout)["ok"] is True


def test_smoke_mock_and_max_round_runs_are_isolated(workspace_layout):
    common = ["--workspace-root", str(workspace_layout.workspace), "--tesseraft-home", str(workspace_layout.home)]
    smoke = run_command([BIN, "run", str(ROOT / "examples/tutorials/smoke/workflow.edn"),
                         "--run-id", "smoke-test", *common, "--format", "json"])
    assert smoke.returncode == 0, smoke.stderr
    assert json.loads(smoke.stdout)["run"]["status"] == "done"

    mock = run_command([BIN, "run", str(ROOT / "test/fixtures/valid/mock-executor/workflow.edn"),
                        "--executor", "mock", "--run-id", "mock-test",
                        "--input", "prompt=Test dry run", "--input", "repo-root=.",
                        *common, "--format", "json"])
    assert mock.returncode == 0, mock.stderr
    mock_dir = Path(json.loads(mock.stdout)["run"]["dir"])
    assert (mock_dir / "execution/status.json").is_file()
    assert (mock_dir / "execution/summary.md").is_file()
    assert ':executor-mode "mock"' in (mock_dir / "state.edn").read_text()

    started = run_command([BIN, "run", "start", str(ROOT / "test/fixtures/valid/max-rounds.workflow.edn"),
                           "--run-id", "max-rounds-test", *common, "--format", "json"])
    assert started.returncode == 0, started.stderr
    run_dir = Path(json.loads(started.stdout)["run"]["dir"])
    for _ in range(3):
        step = run_command([BIN, "run", "step", "--run-dir", str(run_dir), "--format", "json"])
        assert step.returncode == 0, step.stderr
    state = (run_dir / "state.edn").read_text()
    events = read_json_lines(run_dir / "events.jsonl")
    assert ':status "failed"' in state
    assert ":round 3" in state
    limit = [event for event in events if event.get("event") == "run.max-rounds-exceeded"]
    assert len(limit) == 1
    assert limit[0]["round"] == 3 and limit[0]["max_rounds"] == 2
    assert len([event for event in events if event.get("event") == "node.started"]) == 2
