#!/usr/bin/env python3
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "examples" / "playwright-code-review-loop"
WORKFLOW = PACKAGE / "workflow.edn"
RUNNER = PACKAGE / "scripts" / "run_playwright.py"


class PlaywrightCodeReviewWorkflowTest(unittest.TestCase):
    def test_workflow_lints_without_diagnostics(self):
        result = subprocess.run(
            [str(ROOT / "bin" / "tesseraft"), "lint", str(WORKFLOW), "--format", "json"],
            cwd=ROOT, text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        report = json.loads(result.stdout)
        self.assertTrue(report["ok"])
        self.assertEqual(report["diagnostics"], [])

    def test_workflow_replaces_manual_testing_with_playwright_process(self):
        workflow = WORKFLOW.read_text()
        self.assertIn(':metadata {:name "playwright-code-review-loop"', workflow)
        self.assertIn(':playwright-testing', workflow)
        self.assertIn(':command ["./scripts/run_playwright.py"]', workflow)
        self.assertIn('{:when {:status "pass"} :next :playwright-testing}', workflow)
        self.assertIn('{:when {:status "pass"} :next :review}', workflow)
        self.assertIn('{:when {:status "fail"} :effects [:merge-issues :inc-round] :next :execute}', workflow)
        self.assertNotIn(':manual-testing', workflow)
        self.assertNotIn('manual-testing.md.tmpl', workflow)
        review = (PACKAGE / "prompts" / "review.md.tmpl").read_text()
        self.assertIn('playwright/report-{{run.round}}.md', review)

    def invoke_runner(self, run_dir: pathlib.Path, worktree: pathlib.Path, exit_code: int):
        fake_bin = run_dir.parent / "bin"
        fake_bin.mkdir(exist_ok=True)
        fake_npm = fake_bin / "npm"
        fake_npm.write_text(
            f"#!{sys.executable}\n"
            "import sys\n"
            "print('fake Playwright output')\n"
            f"raise SystemExit({exit_code})\n"
        )
        fake_npm.chmod(0o755)
        request = {
            "run": {"round": 3, "worktree-dir": str(worktree)},
            "paths": {"run_dir": str(run_dir)},
            "node": {"inputs": {}},
        }
        env = {**os.environ, "PATH": f"{fake_bin}{os.pathsep}{os.environ.get('PATH', '')}"}
        return subprocess.run(
            [sys.executable, str(RUNNER)], input=json.dumps(request), text=True,
            capture_output=True, cwd=PACKAGE, env=env,
        )

    def test_runner_returns_pass_and_report_for_success(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            run_dir = root / "run"
            worktree = root / "worktree"
            run_dir.mkdir()
            worktree.mkdir()
            result = self.invoke_runner(run_dir, worktree, 0)
            self.assertEqual(result.returncode, 0, result.stderr)
            response = json.loads(result.stdout)
            self.assertEqual(response["status"], "pass")
            self.assertIsNone(response["issues_file"])
            report = run_dir / response["outputs"]["report"]
            self.assertIn("fake Playwright output", report.read_text())
            self.assertIn("Result: **PASS**", report.read_text())

    def test_runner_returns_retryable_failure_and_schema_valid_issues(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            run_dir = root / "run"
            worktree = root / "worktree"
            run_dir.mkdir()
            worktree.mkdir()
            result = self.invoke_runner(run_dir, worktree, 7)
            self.assertEqual(result.returncode, 0, result.stderr)
            response = json.loads(result.stdout)
            self.assertEqual(response["status"], "fail")
            self.assertEqual(response["issues_file"], "playwright/issues-3.json")
            issues = json.loads((run_dir / response["issues_file"]).read_text())
            self.assertEqual(issues[0]["source"], "playwright-testing")
            self.assertEqual(issues[0]["severity"], "major")
            self.assertIn("exited with code 7", issues[0]["details"])
            self.assertIn("Result: **FAIL**", (run_dir / "playwright/report-3.md").read_text())

    def test_malformed_request_is_runner_failure(self):
        result = subprocess.run(
            [sys.executable, str(RUNNER)], input=json.dumps({"paths": {"run_dir": "."}}),
            text=True, capture_output=True, cwd=PACKAGE,
        )
        self.assertEqual(result.returncode, 2)
        self.assertIn("requires run.worktree-dir", result.stderr)


if __name__ == "__main__":
    unittest.main()
