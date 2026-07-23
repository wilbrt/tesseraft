#!/usr/bin/env python3
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "examples" / "focused-tdd-to-pr"
WORKFLOW = PACKAGE / "workflow.edn"
RUNNER = PACKAGE / "scripts" / "run_validation.py"


class FocusedTddWorkflowTest(unittest.TestCase):
    def test_workflow_lints_without_diagnostics(self):
        result = subprocess.run(
            [str(ROOT / "bin" / "tesseraft"), "lint", str(WORKFLOW), "--format", "json"],
            cwd=ROOT, text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        report = json.loads(result.stdout)
        self.assertTrue(report["ok"])
        self.assertEqual(report["diagnostics"], [])

    def test_workflow_encodes_lightweight_convergence_loop(self):
        workflow = WORKFLOW.read_text()
        self.assertIn(':max-rounds 10', workflow)
        self.assertEqual(workflow.count(':prompt-template'), 4)
        self.assertIn(':next :execute-tdd', workflow)
        self.assertIn('{:when {:status "pass"} :next :run-validation}', workflow)
        self.assertIn('{:when {:status "pass"} :next :review}', workflow)
        self.assertIn('{:when {:status "pass"} :effects [:clear-issues] :next :pr-draft}', workflow)
        self.assertEqual(
            workflow.count('{:when {:status "fail"} :effects [:inc-round] :next :execute-tdd}'),
            3,
        )
        self.assertNotIn(':merge-issues', workflow)
        for removed_state in (
            ':prepare-test', ':run-red-check', ':implement-green', ':run-green-check', ':repair',
        ):
            self.assertNotIn(removed_state, workflow)
        for removed_artifact in ('scenario', 'focused-check', 'test-list/', 'tdd/'):
            self.assertNotIn(removed_artifact, workflow)

    def test_only_feedback_returns_increment_rounds(self):
        workflow = WORKFLOW.read_text()
        self.assertEqual(workflow.count(':inc-round'), 3)
        self.assertIn('{:when {:status "fail"} :next :design}', workflow)
        self.assertIn('{:when {:status "fail"} :next :pr-draft}', workflow)
        self.assertNotIn(':effects [:inc-round] :next :design', workflow)
        self.assertNotIn(':effects [:inc-round] :next :pr-draft', workflow)
        self.assertIn('design/status-{{run.attempt}}.json', workflow)
        self.assertIn('pr/draft-status-{{run.attempt}}.json', workflow)

    def test_prompts_require_coherent_tdd_current_findings_and_whole_diff_review(self):
        design = (PACKAGE / "prompts" / "design.md.tmpl").read_text()
        execute = (PACKAGE / "prompts" / "execute-tdd.md.tmpl").read_text()
        review = (PACKAGE / "prompts" / "review.md.tmpl").read_text()
        self.assertIn("Do not create a scenario ledger", design)
        self.assertIn("complete coherent behavior", execute)
        self.assertIn("newest round-stamped issue file", execute)
        self.assertIn("do not assume it exhausts the contract", execute)
        self.assertIn("every explicitly named production consumer or boundary", execute)
        self.assertIn("whole base-branch diff", review)
        self.assertIn("all independent blockers", review)
        self.assertIn("Do not repeat resolved historical findings", review)

    def test_validation_runner_uses_only_final_plan_and_declared_paths(self):
        spec = importlib.util.spec_from_file_location("focused_validation", RUNNER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual(
            module.artifact_paths(3),
            ("validation/report-3.md", "validation/issues-3.json"),
        )
        source = RUNNER.read_text()
        self.assertNotIn("scenario", source.lower())
        self.assertNotIn("focused check", source.lower())
        self.assertNotIn("red_passed", source)

    def run_validation(self, run_dir, worktree, checks, round_number=2):
        design_dir = run_dir / "design"
        design_dir.mkdir(parents=True)
        (design_dir / "validation-plan.json").write_text(json.dumps({"version": 1, "checks": checks}))
        request = {
            "run": {"round": round_number, "worktree-dir": str(worktree)},
            "paths": {"run_dir": str(run_dir)},
            "node": {"inputs": {}},
        }
        return subprocess.run(
            [sys.executable, str(RUNNER)], input=json.dumps(request), text=True,
            capture_output=True, cwd=PACKAGE,
        )

    def test_validation_runner_passes_without_scenario_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            worktree = root / "worktree"
            worktree.mkdir()
            run_dir = root / "run"
            result = self.run_validation(
                run_dir, worktree,
                [{"id": "pass", "command": [sys.executable, "-c", "print('validated')"],
                  "timeout_seconds": 10}],
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            response = json.loads(result.stdout)
            self.assertEqual(response["status"], "pass")
            self.assertIsNone(response["issues_file"])
            report = pathlib.Path(response["outputs"]["report"])
            self.assertIn("validated", (run_dir / report).read_text())

    def test_validation_failure_is_current_and_machine_authoritative(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            worktree = root / "worktree"
            worktree.mkdir()
            run_dir = root / "run"
            result = self.run_validation(
                run_dir, worktree,
                [{"id": "fail", "command": [sys.executable, "-c", "import sys; print('broken'); sys.exit(7)"],
                  "timeout_seconds": 10}],
                round_number=4,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            response = json.loads(result.stdout)
            self.assertEqual(response["status"], "fail")
            self.assertEqual(response["issues_file"], "validation/issues-4.json")
            issues = json.loads((run_dir / response["issues_file"]).read_text())
            self.assertEqual(len(issues), 1)
            self.assertIn("exited 7", issues[0]["details"])
            self.assertIn("broken", (run_dir / "validation/report-4.md").read_text())

    def test_mock_feedback_cycle_reaches_pr_without_scenario_artifacts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            repo = root / "repo"
            repo.mkdir()
            counter = root / "validation-count"
            runs_root = root / "runs"
            validation_code = (
                "import pathlib,sys; p=pathlib.Path(sys.argv[1]); "
                "n=int(p.read_text())+1 if p.exists() else 1; p.write_text(str(n)); "
                "print(f'validation {n}'); sys.exit(1 if n == 1 else 0)"
            )

            def command(*args):
                result = subprocess.run(
                    [str(ROOT / "bin" / "tesseraft"), "run", *args, "--format", "json"],
                    cwd=ROOT, text=True, capture_output=True,
                )
                self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
                return json.loads(result.stdout)

            started = command(
                "start", str(WORKFLOW), "--executor", "mock", "--run-id", "feedback",
                "--runs-root", str(runs_root), "--input", "prompt=mock feedback",
                "--input", f"repo-root={repo}", "--input", "base-branch=main",
            )
            run_dir = pathlib.Path(started["run"]["dir"])

            def step():
                return command("step", "--run-dir", str(run_dir))

            def agent_result(directory, round_number, status, report_name="summary"):
                target = run_dir / directory
                target.mkdir(parents=True, exist_ok=True)
                suffix = f"-{round_number}"
                (target / f"{report_name}{suffix}.md").write_text(f"{status} fixture\n")
                issues_file = None
                if status == "fail":
                    issues_file = f"{directory}/issues{suffix}.json"
                    (target / f"issues{suffix}.json").write_text('[{"title":"current fixture"}]\n')
                (target / f"status{suffix}.json").write_text(json.dumps({
                    "status": status, "summary": f"{status} fixture", "issues_file": issues_file,
                }))

            self.assertEqual(step()["run"]["state"], "design")
            self.assertEqual(step()["run"]["state"], "ensure-worktree")
            (run_dir / "design" / "validation-plan.json").write_text(json.dumps({
                "version": 1,
                "checks": [{"id": "mock-cycle", "command": [sys.executable, "-c", validation_code, str(counter)],
                            "timeout_seconds": 10}],
            }))
            self.assertEqual(step()["run"]["state"], "execute-tdd")

            agent_result("execution", 1, "fail")
            state = step()["run"]
            self.assertEqual((state["state"], state["round"]), ("execute-tdd", 2))
            self.assertEqual(step()["run"]["state"], "run-validation")
            state = step()["run"]
            self.assertEqual((state["state"], state["round"]), ("execute-tdd", 3))
            self.assertEqual(step()["run"]["state"], "run-validation")
            self.assertEqual(step()["run"]["state"], "review")

            agent_result("review", 3, "fail", report_name="report")
            state = step()["run"]
            self.assertEqual((state["state"], state["round"]), ("execute-tdd", 4))
            self.assertEqual(step()["run"]["state"], "run-validation")
            self.assertEqual(step()["run"]["state"], "review")
            self.assertEqual(step()["run"]["state"], "pr-draft")
            self.assertEqual(step()["run"]["state"], "create-pr")
            finished = step()["run"]
            self.assertEqual((finished["state"], finished["status"], finished["round"]), ("done", "done", 4))
            self.assertFalse((run_dir / "test-list").exists())
            self.assertFalse((run_dir / "tdd").exists())


if __name__ == "__main__":
    unittest.main()
