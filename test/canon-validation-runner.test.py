#!/usr/bin/env python3
import json
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
RUNNER = ROOT / "examples" / "canon-tdd-to-pr" / "scripts" / "run_validation.py"


class ValidationRunnerTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.temp.name)
        self.run_dir = self.root / "run"
        self.worktree = self.root / "worktree"
        (self.run_dir / "tdd").mkdir(parents=True)
        (self.run_dir / "design").mkdir()
        (self.run_dir / "test-list").mkdir()
        self.worktree.mkdir()
        subprocess.run(["git", "init", "-q"], cwd=self.worktree, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.invalid"], cwd=self.worktree, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=self.worktree, check=True)
        (self.worktree / "seed.txt").write_text("seed\n")
        subprocess.run(["git", "add", "."], cwd=self.worktree, check=True)
        subprocess.run(["git", "commit", "-qm", "seed"], cwd=self.worktree, check=True)

    def tearDown(self):
        self.temp.cleanup()

    def request(self, phase, round_number=1, manifest_file=None):
        inputs = {"phase": phase}
        if manifest_file:
            inputs["manifest-file"] = manifest_file
        return {
            "run": {"round": round_number, "worktree-dir": str(self.worktree)},
            "node": {"inputs": inputs},
            "inputs": {"repo-root": str(self.worktree)},
            "paths": {"run_dir": str(self.run_dir), "repo_root": str(self.worktree)},
        }

    def invoke(self, request):
        return subprocess.run(
            ["python3", str(RUNNER)], input=json.dumps(request), text=True,
            capture_output=True, cwd=ROOT,
        )

    def write_check(self, round_number, command, marker="EXPECTED_RED", scenario="SC-001"):
        path = self.run_dir / "tdd" / f"check-{round_number}.json"
        path.write_text(json.dumps({
            "version": 1,
            "scenario_id": scenario,
            "id": f"focused-{round_number}",
            "command": command,
            "timeout_seconds": 10,
            "red": {"expected_exit": "nonzero", "output_contains": [marker]},
        }))
        return path

    def test_red_expected_failure_is_declared_pass(self):
        (self.worktree / "test" / "new_behavior_test.py").parent.mkdir()
        (self.worktree / "test" / "new_behavior_test.py").write_text("assert False, 'EXPECTED_RED'\n")
        self.write_check(1, ["bash", "-lc", "echo EXPECTED_RED >&2; exit 1"])
        result = self.invoke(self.request("red", manifest_file="tdd/check-{{run.round}}.json"))
        self.assertEqual(result.returncode, 0, result.stderr)
        response = json.loads(result.stdout)
        self.assertEqual(response["status"], "pass")
        report = (self.run_dir / "tdd" / "red-verification-1.md").read_text()
        self.assertIn("?? test/new_behavior_test.py", report)
        self.assertIn("+++ b/test/new_behavior_test.py", report)
        self.assertIn("+assert False, 'EXPECTED_RED'", report)

    def test_red_report_includes_staged_test_evidence(self):
        (self.worktree / "test_behavior.py").write_text("assert False, 'EXPECTED_RED'\n")
        subprocess.run(["git", "add", "test_behavior.py"], cwd=self.worktree, check=True)
        self.write_check(1, ["bash", "-lc", "echo EXPECTED_RED >&2; exit 1"])
        result = self.invoke(self.request("red", manifest_file="tdd/check-1.json"))
        self.assertEqual(result.returncode, 0, result.stderr)
        report = (self.run_dir / "tdd" / "red-verification-1.md").read_text()
        self.assertIn("A  test_behavior.py", report)
        self.assertIn("+++ b/test_behavior.py", report)

    def test_red_expected_failure_without_test_diff_is_workflow_fail(self):
        self.write_check(1, ["bash", "-lc", "echo EXPECTED_RED >&2; exit 1"])
        result = self.invoke(self.request("red", manifest_file="tdd/check-1.json"))
        self.assertEqual(result.returncode, 0, result.stderr)
        response = json.loads(result.stdout)
        self.assertEqual(response["status"], "fail")
        issues = (self.run_dir / response["issues_file"]).read_text()
        self.assertIn("red evidence requires non-empty worktree changes and diff", issues)

    def test_red_unexpected_pass_is_workflow_fail_not_process_failure(self):
        self.write_check(1, ["true"])
        result = self.invoke(self.request("red", manifest_file="tdd/check-{{run.round}}.json"))
        self.assertEqual(result.returncode, 0, result.stderr)
        response = json.loads(result.stdout)
        self.assertEqual(response["status"], "fail")
        self.assertEqual(response["issues_file"], "tdd/red-verification-issues-1.json")

    def test_green_uses_latest_manifest_per_scenario(self):
        self.write_check(1, ["false"])
        self.write_check(2, ["true"])
        result = self.invoke(self.request("green", round_number=2))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "pass")

    def test_regression_runs_broad_and_focused_and_requires_empty_list(self):
        self.write_check(1, ["true"])
        (self.run_dir / "design" / "validation-plan.json").write_text(json.dumps({
            "version": 1,
            "checks": [{"id": "full", "command": ["true"], "timeout_seconds": 10}],
        }))
        (self.run_dir / "test-list" / "scenarios-initial.json").write_text(json.dumps({
            "version": 1,
            "scenarios": [{"id": "SC-001", "state": "pending"}],
        }))
        (self.run_dir / "test-list" / "scenarios-1.json").write_text(json.dumps({
            "version": 1,
            "scenarios": [{"id": "SC-001", "state": "complete"}],
        }))
        result = self.invoke(self.request("regression"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["status"], "pass")

    def test_malformed_manifest_is_external_runner_failure(self):
        (self.run_dir / "tdd" / "check-1.json").write_text("{}")
        result = self.invoke(self.request("red", manifest_file="tdd/check-1.json"))
        self.assertEqual(result.returncode, 2)
        self.assertIn("validation runner error", result.stderr)


if __name__ == "__main__":
    unittest.main()
