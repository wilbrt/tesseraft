#!/usr/bin/env python3
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "examples" / "catalog" / "design-interrogated-tdd-to-pr"
WORKFLOW = PACKAGE / "workflow.edn"
RUNNER = PACKAGE / "scripts" / "run_validation.py"


class DesignInterrogatedTddWorkflowTest(unittest.TestCase):
    def test_workflow_lints_without_diagnostics(self):
        result = subprocess.run(
            [str(ROOT / "bin" / "tesseraft"), "lint", str(WORKFLOW), "--format", "json"],
            cwd=ROOT, text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        report = json.loads(result.stdout)
        self.assertTrue(report["ok"])
        self.assertEqual(report["diagnostics"], [])

    def test_graph_requires_interrogation_and_failure_design(self):
        workflow = WORKFLOW.read_text()
        self.assertIn(':max-rounds 10', workflow)
        self.assertEqual(workflow.count(':prompt-template'), 6)
        self.assertIn('{:when {:status "pass"} :next :design-interrogation}', workflow)
        self.assertIn('{:when {:status "pass"} :next :ensure-worktree}', workflow)
        self.assertIn('{:when {:status "fail"} :next :design}]', workflow)
        self.assertEqual(
            workflow.count('{:when {:status "fail"} :effects [:inc-round] :next :failure-design}'),
            3,
        )
        self.assertIn('{:when {:status "pass"} :next :execute-tdd}', workflow)
        self.assertIn('{:when {:status "fail"} :next :failure-design}', workflow)
        self.assertNotIn(
            '{:when {:status "fail"} :effects [:inc-round] :next :execute-tdd}',
            workflow,
        )
        self.assertEqual(workflow.count(':thinking "high"'), 2)
        self.assertIn(':model "gpt-5.5"', workflow)

    def test_prompts_enforce_independent_critique_and_root_cause_redesign(self):
        design = (PACKAGE / "prompts" / "design.md.tmpl").read_text()
        interrogation = (PACKAGE / "prompts" / "design-interrogation.md.tmpl").read_text()
        failure_design = (PACKAGE / "prompts" / "failure-design.md.tmpl").read_text()
        execute = (PACKAGE / "prompts" / "execute-tdd.md.tmpl").read_text()

        self.assertIn("newest attempt-stamped report", design)
        self.assertIn("Resolve every material concern", design)
        self.assertIn("existing implementations, abstractions, helpers, schemas", interrogation)
        self.assertIn("parallel paths that would create two sources of truth", interrogation)
        self.assertIn("Fail only for material design risks", interrogation)
        self.assertIn("Identify only the newest round-stamped issue file", failure_design)
        self.assertIn("Distinguish the root cause from the failing symptom", failure_design)
        self.assertIn("approach that should not be retried", failure_design)
        self.assertIn("read it before changing code", execute)
        self.assertIn("avoid introducing parallel implementations", execute)

    def test_validation_runner_uses_round_stamped_current_artifacts(self):
        spec = importlib.util.spec_from_file_location("design_interrogated_validation", RUNNER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual(
            module.artifact_paths(4),
            ("validation/report-4.md", "validation/issues-4.json"),
        )

    def test_mock_failures_always_receive_design_before_retry(self):
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
                "start", str(WORKFLOW), "--executor", "mock", "--run-id", "design-loop",
                "--runs-root", str(runs_root), "--input", "prompt=mock design loop",
                "--input", f"repo-root={repo}", "--input", "base-branch=main",
            )
            run_dir = pathlib.Path(started["run"]["dir"])

            def step():
                return command("step", "--run-dir", str(run_dir))["run"]

            def issue(source):
                return [{
                    "source": source,
                    "severity": "major",
                    "title": f"{source} fixture",
                    "details": "current failure evidence",
                    "acceptance_criteria": "fixture passes",
                }]

            def write_agent_failure(directory, stamp, report_name, source):
                target = run_dir / directory
                target.mkdir(parents=True, exist_ok=True)
                issues_rel = f"{directory}/issues-{stamp}.json"
                (target / f"{report_name}-{stamp}.md").write_text("fixture failure\n")
                (target / f"issues-{stamp}.json").write_text(json.dumps(issue(source)))
                (target / f"status-{stamp}.json").write_text(json.dumps({
                    "status": "fail",
                    "summary": "fixture failure",
                    "issues_file": issues_rel,
                }))

            self.assertEqual(step()["state"], "design")
            state = step()
            self.assertEqual(state["state"], "design-interrogation")

            interrogation_attempt = state["attempt"]
            write_agent_failure(
                "design-interrogation", interrogation_attempt, "report", "design-interrogation",
            )
            self.assertEqual(step()["state"], "design")
            self.assertEqual(step()["state"], "design-interrogation")
            self.assertEqual(step()["state"], "ensure-worktree")

            (run_dir / "design" / "validation-plan.json").write_text(json.dumps({
                "version": 1,
                "checks": [{
                    "id": "mock-cycle",
                    "command": [sys.executable, "-c", validation_code, str(counter)],
                    "timeout_seconds": 10,
                }],
            }))
            self.assertEqual(step()["state"], "execute-tdd")

            write_agent_failure("execution", 1, "summary", "execution")
            state = step()
            self.assertEqual((state["state"], state["round"]), ("failure-design", 2))
            self.assertEqual(step()["state"], "execute-tdd")
            self.assertEqual(step()["state"], "run-validation")

            state = step()
            self.assertEqual((state["state"], state["round"]), ("failure-design", 3))
            self.assertEqual(step()["state"], "execute-tdd")
            self.assertEqual(step()["state"], "run-validation")
            self.assertEqual(step()["state"], "review")

            write_agent_failure("review", 3, "report", "review")
            state = step()
            self.assertEqual((state["state"], state["round"]), ("failure-design", 4))
            self.assertEqual(step()["state"], "execute-tdd")
            self.assertEqual(step()["state"], "run-validation")
            self.assertEqual(step()["state"], "review")
            self.assertEqual(step()["state"], "pr-draft")
            self.assertEqual(step()["state"], "create-pr")
            finished = step()
            self.assertEqual(
                (finished["state"], finished["status"], finished["round"]),
                ("done", "done", 4),
            )
            self.assertTrue((run_dir / "failure-design" / "guidance-2.md").exists())
            self.assertTrue((run_dir / "failure-design" / "guidance-3.md").exists())
            self.assertTrue((run_dir / "failure-design" / "guidance-4.md").exists())


if __name__ == "__main__":
    unittest.main()
