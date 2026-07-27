#!/usr/bin/env python3
"""Contract test for the deterministic-code-review-loop example.

Asserts the workflow lints and that it structurally enforces the
deterministic-first policy: agents design/implement/review, and BOTH test
layers (bb test + Playwright) are distinct deterministic :process nodes that
agents cannot bypass. Also exercises the bb test runner's malformed-request
failure path (runner fault -> nonzero exit) so a runner bug can never be
mistaken for a test result.
"""
import json
import pathlib
import subprocess
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "examples" / "deterministic-code-review-loop"
WORKFLOW = PACKAGE / "workflow.edn"
BB_RUNNER = PACKAGE / "scripts" / "run_bb_test.py"
PW_RUNNER = PACKAGE / "scripts" / "run_playwright.py"


class DeterministicCodeReviewWorkflowTest(unittest.TestCase):
    def test_workflow_lints_without_diagnostics(self):
        result = subprocess.run(
            [str(ROOT / "bin" / "tesseraft"), "lint", str(WORKFLOW), "--format", "json"],
            cwd=ROOT, text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        report = json.loads(result.stdout)
        self.assertTrue(report["ok"])
        self.assertEqual(report["diagnostics"], [])

    def test_workflow_enforces_deterministic_first_two_gates(self):
        """Both test layers are deterministic :process nodes; agents never run them."""
        workflow = WORKFLOW.read_text()
        self.assertIn(':metadata {:name "deterministic-code-review-loop"', workflow)
        # Cheap/fast gate first, runs bb test.
        self.assertIn(':bb-test-gate', workflow)
        self.assertIn(':command ["./scripts/run_bb_test.py"]', workflow)
        # Expensive gate second, runs Playwright, on bb-green only.
        self.assertIn(':playwright-gate', workflow)
        self.assertIn(':command ["./scripts/run_playwright.py"]', workflow)
        # implement -> bb gate -> playwright gate -> review (the edges enforce the order; no skip path).
        self.assertIn('{:when {:status "pass"} :next :bb-test-gate}', workflow)
        self.assertIn('{:when {:status "pass"} :next :playwright-gate}', workflow)
        self.assertIn('{:when {:status "pass"} :next :review}', workflow)
        # Both gates loop back to :implement on failure (deterministic feedback to the agent).
        self.assertIn('{:when {:status "fail"} :effects [:merge-issues :inc-round] :next :implement}', workflow)
        # Agents use the claude-code subscription executor, not pi.
        self.assertIn(':executor :claude-code', workflow)
        self.assertNotIn(':executor :pi-cli', workflow)
        # There is no agent node that runs npm/bb tests directly.
        self.assertNotIn(':manual-testing', workflow)

    def test_prompts_forbid_agent_run_tests(self):
        """Every agent prompt states the deterministic-first testing policy."""
        for name in ("design", "implement", "review", "pr-draft"):
            prompt = (PACKAGE / "prompts" / f"{name}.md.tmpl").read_text()
            self.assertIn("Testing is NOT your job", prompt, f"{name} prompt must state the testing policy")
            self.assertIn("Do NOT run tests", prompt, f"{name} prompt must forbid running tests")
        # The implement prompt's pass-status must NOT claim validation (the gates own that signal).
        implement = (PACKAGE / "prompts" / "implement.md.tmpl").read_text()
        self.assertIn("deterministic gates pending", implement)
        self.assertNotIn("implemented and validated", implement)

    def test_review_prompt_references_both_gate_reports(self):
        review = (PACKAGE / "prompts" / "review.md.tmpl").read_text()
        self.assertIn("bb-test/report-{{run.round}}.md", review)
        self.assertIn("playwright/report-{{run.round}}.md", review)

    def test_bb_runner_malformed_request_is_runner_failure(self):
        """A malformed request must exit nonzero so it can never be read as a test PASS/FAIL."""
        result = subprocess.run(
            [sys.executable, str(BB_RUNNER)],
            input=json.dumps({"paths": {"run_dir": "."}}),
            cwd=ROOT, text=True, capture_output=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("requires run.worktree-dir", result.stderr)

    def test_runners_are_executable_and_present(self):
        for runner in (BB_RUNNER, PW_RUNNER):
            self.assertTrue(runner.is_file(), f"missing runner: {runner}")
            self.assertTrue(runner.stat().st_mode & 0o111, f"runner not executable: {runner}")


if __name__ == "__main__":
    unittest.main()