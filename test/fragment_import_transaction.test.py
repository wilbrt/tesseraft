#!/usr/bin/env python3
import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

ROOT = Path.cwd()
EXAMPLE = ROOT / "examples/fragments/test-fix-loop"

BASE_WORKFLOW = '''{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {:name "import-transaction"}
 :inputs {:repo-root {:type :string :required true}
          :test-cmd {:type :string :required true}}
 :defaults {:max-rounds 3 :state-timeout "10m"}
 :policies {:require-timeouts true :require-max-rounds true}
 :initial :run-tests
 :states {:done {:type :terminal :status :success}
          :abort {:type :terminal :status :failure}}}
'''

# :initial already resolves to an existing state and the sole terminal is
# reachable, so this workflow is strict-lint-clean before any import -- used
# to prove a diagnostic the import itself creates still blocks.
CLEAN_SINGLE_TERMINAL_WORKFLOW = '''{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {:name "import-transaction-clean"}
 :inputs {:repo-root {:type :string :required true}
          :test-cmd {:type :string :required true}}
 :defaults {:max-rounds 3 :state-timeout "10m"}
 :policies {:require-timeouts true :require-max-rounds true}
 :initial :done
 :states {:done {:type :terminal :status :success}}}
'''


def with_tmp(fn):
    tmp = Path(tempfile.mkdtemp(prefix="tesseraft-fi5-"))
    try:
        return fn(tmp)
    finally:
        shutil.rmtree(tmp)


def write_project(tmp: Path, workflow_text=BASE_WORKFLOW):
    package_root = tmp / ".tesseraft/fragments/test-fix-loop"
    shutil.copytree(EXAMPLE, package_root)
    wf = tmp / "workflow.edn"
    wf.write_text(workflow_text)
    return package_root / "fragment.edn", wf


def write_project_with_workflow_asset_conflict(tmp: Path):
    """A package that declares an asset whose path resolves onto the
    importing workflow file itself, to exercise the
    'Refusing to overwrite workflow file with an asset' guard."""
    package_root = tmp / ".tesseraft/fragments/test-fix-loop"
    shutil.copytree(EXAMPLE, package_root)
    fragment_path = package_root / "fragment.edn"
    original = fragment_path.read_text()
    marker = ':assets {:prompts ["prompts/fix.md.tmpl"]\n          :schemas ["schemas/status.schema.json"]}'
    replacement = ':assets {:prompts ["prompts/fix.md.tmpl"]\n          :schemas ["schemas/status.schema.json"]\n          :configs ["workflow.edn"]}'
    assert marker in original, original
    fragment_path.write_text(original.replace(marker, replacement))
    (package_root / "workflow.edn").write_text("{:not :the-real-workflow}\n")
    wf = tmp / "workflow.edn"
    wf.write_text(BASE_WORKFLOW)
    return fragment_path, wf


def snapshot(tmp: Path):
    data = {}
    for p in sorted(tmp.rglob("*")):
        if p.is_file():
            data[str(p.relative_to(tmp))] = p.read_bytes()
    return data


def tesseraft(args, home: Path):
    env = os.environ.copy()
    env["TESSERAFT_HOME"] = str(home)
    return subprocess.run(
        ["./bin/tesseraft", *args],
        cwd=ROOT,
        env=env,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )


def lint_json(wf: Path, home: Path, strict=False):
    args = ["lint", str(wf), "--format", "json"]
    if strict:
        args.append("--strict")
    proc = tesseraft(args, home)
    assert proc.stdout, proc.stderr
    return proc.returncode, json.loads(proc.stdout)


def import_args(fragment: Path, wf: Path):
    return [
        "fragment", "import", str(fragment), str(wf),
        "--as", "run-tests",
        "--input", 'repo-root="{{inputs.repo-root}}"',
        "--input", 'test-cmd="{{inputs.test-cmd}}"',
        "--parameter", "max-rounds=3",
        "--parameter", 'base-branch="main"',
        "--version", "0.1.0",
        "--scope", "project",
        "--prefix", "imported/test-fix-loop",
        "--outcome", "pass=done",
        "--outcome", "fail=abort",
    ]


def without_pair(args, flag, value):
    copy = list(args)
    for i in range(len(copy) - 1):
        if copy[i] == flag and copy[i + 1] == value:
            return copy[:i] + copy[i + 2:]
    raise AssertionError((flag, value, args))


def test_success_writes_complete_strict_linting_inclusion_and_summary():
    def run(tmp):
        fragment, wf = write_project(tmp)
        proc = tesseraft(import_args(fragment, wf), tmp / "home")
        assert proc.returncode == 0, proc.stderr
        assert "State: run-tests" in proc.stdout, proc.stdout
        assert "Inputs: repo-root, test-cmd" in proc.stdout, proc.stdout
        assert "Outcomes: fail->abort, pass->done" in proc.stdout, proc.stdout
        text = wf.read_text()
        assert ":run-tests" in text and ":fragment " in text, text
        assert ":transitions" in text, text
        assert ":inputs" in text and "{{inputs.repo-root}}" in text, text
        assert ":parameters" in text and ":base-branch" in text, text
        assert ":version " in text and ":scope " in text and ":prefix " in text, text
        assert (tmp / "prompts/fix.md.tmpl").exists(), text
        assert (tmp / "schemas/status.schema.json").exists(), text
        status, payload = lint_json(wf, tmp / "home", strict=True)
        assert status == 0, payload
        inclusion = payload["fragment-inclusions"]["run-tests"]
        assert inclusion["inputs"] == {"repo-root": "{{inputs.repo-root}}", "test-cmd": "{{inputs.test-cmd}}"}, inclusion
        assert inclusion["parameters"]["base-branch"] == "main", inclusion
        assert inclusion["prefix"] == "imported/test-fix-loop", inclusion
    with_tmp(run)


def assert_rollback(tmp: Path, args, expected):
    before = snapshot(tmp)
    proc = tesseraft(args, tmp / "home")
    assert proc.returncode != 0, proc.stdout
    assert expected in proc.stderr, proc.stderr
    assert snapshot(tmp) == before


def test_failures_leave_workflow_and_assets_unchanged():
    def run(tmp):
        fragment, wf = write_project(tmp)
        base = import_args(fragment, wf)
        cases = [
            (without_pair(base, "--input", 'test-cmd="{{inputs.test-cmd}}"'), "fragment-input-binding-missing"),
            (without_pair(base, "--outcome", "fail=abort") + ["--outcome", "fail=missing"], "Transition target does not exist"),
            (base + ["--input", 'repo-root="again"'], "Duplicate --input binding"),
            (without_pair(base, "--outcome", "fail=abort"), "Missing route"),
        ]
        for args, expected in cases:
            assert_rollback(tmp, args, expected)
        (tmp / "prompts").mkdir()
        (tmp / "prompts/fix.md.tmpl").write_text("different")
        assert_rollback(tmp, base, "Refusing to overwrite different asset")
    with_tmp(run)


def test_existing_state_id_is_rejected_without_mutation():
    def run(tmp):
        fragment, wf = write_project(tmp, BASE_WORKFLOW.replace(':done {:type :terminal :status :success}', ':run-tests {:type :terminal :status :success}\n          :done {:type :terminal :status :success}'))
        assert_rollback(tmp, import_args(fragment, wf), "Workflow state already exists")
    with_tmp(run)


def test_asset_that_would_overwrite_workflow_file_is_rejected_without_mutation():
    def run(tmp):
        fragment, wf = write_project_with_workflow_asset_conflict(tmp)
        assert_rollback(tmp, import_args(fragment, wf), "Refusing to overwrite workflow file with an asset")
    with_tmp(run)


def test_partial_commit_failure_rolls_back_previously_installed_assets():
    """The example package installs prompts/fix.md.tmpl before
    schemas/status.schema.json. Pre-creating 'schemas' as a regular file
    passes asset-plan (the destination file does not exist yet) but makes
    the second asset's directory creation fail after the first asset has
    already been staged into place, exercising commit-transaction!'s
    rollback of a previously installed asset and its empty parent dir."""
    def run(tmp):
        fragment, wf = write_project(tmp)
        (tmp / "schemas").write_text("blocking file, not a directory")
        before = snapshot(tmp)
        proc = tesseraft(import_args(fragment, wf), tmp / "home")
        assert proc.returncode != 0, proc.stdout
        assert "schemas" in proc.stderr, proc.stderr
        assert snapshot(tmp) == before
        assert not (tmp / "prompts").exists(), "first installed asset should be rolled back"
    with_tmp(run)


def test_next_fills_only_unmapped_declared_outcomes():
    def run(tmp):
        fragment, wf = write_project(tmp)
        args = without_pair(import_args(fragment, wf), "--outcome", "fail=abort") + ["--next", "abort"]
        proc = tesseraft(args, tmp / "home")
        assert proc.returncode == 0, proc.stderr
        assert "pass->done" in proc.stdout and "fail->abort" in proc.stdout, proc.stdout
        status, payload = lint_json(wf, tmp / "home", strict=True)
        assert status == 0, payload
    with_tmp(run)


def test_next_rejected_when_every_outcome_already_routed():
    def run(tmp):
        fragment, wf = write_project(tmp)
        args = import_args(fragment, wf) + ["--next", "abort"]
        assert_rollback(tmp, args, "--next is only valid when at least one declared outcome is not routed with --outcome")
    with_tmp(run)


def test_unknown_outcome_route_is_rejected():
    def run(tmp):
        fragment, wf = write_project(tmp)
        args = import_args(fragment, wf) + ["--outcome", "bogus=done"]
        assert_rollback(tmp, args, "Unknown fragment outcome route(s)")
    with_tmp(run)


def test_reuse_action_leaves_preexisting_identical_asset_untouched():
    def run(tmp):
        fragment, wf = write_project(tmp)
        src_dir = fragment.parent
        (tmp / "prompts").mkdir()
        (tmp / "schemas").mkdir()
        shutil.copy(src_dir / "prompts/fix.md.tmpl", tmp / "prompts/fix.md.tmpl")
        shutil.copy(src_dir / "schemas/status.schema.json", tmp / "schemas/status.schema.json")
        before_prompts_mtime = (tmp / "prompts/fix.md.tmpl").stat().st_mtime_ns
        before_schemas_mtime = (tmp / "schemas/status.schema.json").stat().st_mtime_ns
        proc = tesseraft(import_args(fragment, wf), tmp / "home")
        assert proc.returncode == 0, proc.stderr
        assert (tmp / "prompts/fix.md.tmpl").stat().st_mtime_ns == before_prompts_mtime
        assert (tmp / "schemas/status.schema.json").stat().st_mtime_ns == before_schemas_mtime
        assert (tmp / "prompts/fix.md.tmpl").read_bytes() == (src_dir / "prompts/fix.md.tmpl").read_bytes()
        assert (tmp / "schemas/status.schema.json").read_bytes() == (src_dir / "schemas/status.schema.json").read_bytes()
    with_tmp(run)


def test_import_succeeds_despite_preexisting_unreachable_terminal():
    """BASE_WORKFLOW's :abort is unreachable before any import: :initial
    names :run-tests, which does not exist in :states until this very import
    creates it, so nothing ever routes to :abort on its own. Routing both
    declared outcomes to :done (never to :abort) leaves that same
    pre-existing unreachable-state diagnostic untouched -- not introduced by
    the import -- so a whole-workflow strict gate must not block this
    otherwise complete, fully-bound import."""
    def run(tmp):
        fragment, wf = write_project(tmp)
        args = without_pair(import_args(fragment, wf), "--outcome", "fail=abort") + ["--outcome", "fail=done"]
        proc = tesseraft(args, tmp / "home")
        assert proc.returncode == 0, proc.stderr
        assert "pass->done" in proc.stdout and "fail->done" in proc.stdout, proc.stdout
    with_tmp(run)


def test_import_blocked_by_diagnostic_the_import_itself_introduces():
    """CLEAN_SINGLE_TERMINAL_WORKFLOW is strict-lint-clean before import: its
    sole state is also :initial. Importing a new node that nothing
    transitions into leaves that new node itself unreachable -- a diagnostic
    that did not and could not exist before the import -- which must still
    block, unlike the pre-existing case above."""
    def run(tmp):
        fragment, wf = write_project(tmp, CLEAN_SINGLE_TERMINAL_WORKFLOW)
        pre_status, pre_payload = lint_json(wf, tmp / "home", strict=True)
        assert pre_status == 0, pre_payload
        args = without_pair(import_args(fragment, wf), "--outcome", "fail=abort") + ["--outcome", "fail=done"]
        assert_rollback(tmp, args, "Fragment import would introduce a strict lint diagnostic")
    with_tmp(run)


if __name__ == "__main__":
    test_success_writes_complete_strict_linting_inclusion_and_summary()
    test_failures_leave_workflow_and_assets_unchanged()
    test_existing_state_id_is_rejected_without_mutation()
    test_asset_that_would_overwrite_workflow_file_is_rejected_without_mutation()
    test_partial_commit_failure_rolls_back_previously_installed_assets()
    test_next_fills_only_unmapped_declared_outcomes()
    test_next_rejected_when_every_outcome_already_routed()
    test_unknown_outcome_route_is_rejected()
    test_reuse_action_leaves_preexisting_identical_asset_untouched()
    test_import_succeeds_despite_preexisting_unreachable_terminal()
    test_import_blocked_by_diagnostic_the_import_itself_introduces()
