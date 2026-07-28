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


def test_existing_state_and_differing_workflow_file_are_rejected_without_mutation():
    def run(tmp):
        fragment, wf = write_project(tmp, BASE_WORKFLOW.replace(':done {:type :terminal :status :success}', ':run-tests {:type :terminal :status :success}\n          :done {:type :terminal :status :success}'))
        assert_rollback(tmp, import_args(fragment, wf), "Workflow state already exists")
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


if __name__ == "__main__":
    test_success_writes_complete_strict_linting_inclusion_and_summary()
    test_failures_leave_workflow_and_assets_unchanged()
    test_existing_state_and_differing_workflow_file_are_rejected_without_mutation()
    test_next_fills_only_unmapped_declared_outcomes()
