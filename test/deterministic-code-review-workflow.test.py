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
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "examples" / "catalog" / "deterministic-code-review-loop"
WORKFLOW = PACKAGE / "workflow.edn"
BB_RUNNER = PACKAGE / "scripts" / "run_bb_test.py"
PW_RUNNER = PACKAGE / "scripts" / "run_playwright.py"
SYNC_MARKER = "out of sync with STATUS.edn"


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
        # Agents use the standard pi-cli executor; deterministic gates own test execution.
        self.assertIn(':executor :pi-cli', workflow)
        self.assertNotIn(':executor :claude-code', workflow)
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

    # ---- Self-healing the STATUS.edn <-> README.md sync drift ----

    def _load_runner_module(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location("bb_runner", BB_RUNNER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_failed_due_to_status_sync_detection(self):
        """Only the exact sync-check failure is treated as self-healable."""
        bb = self._load_runner_module()
        run = bb.run_bb_test  # noqa: only used to confirm the sentinel is exported
        self.assertTrue(bb.failed_due_to_status_sync(
            {"timed_out": False, "exit_code": 1,
             "stdout": f"README.md status section is {SYNC_MARKER}.", "stderr": ""}))
        self.assertTrue(bb.failed_due_to_status_sync(
            {"timed_out": False, "exit_code": 1,
             "stdout": "", "stderr": f"README.md status section is {SYNC_MARKER}."}))
        # A PASS, a timeout, a missing-bb (127), or a real test failure is NOT healable.
        self.assertFalse(bb.failed_due_to_status_sync(
            {"timed_out": False, "exit_code": 0, "stdout": "", "stderr": ""}))
        self.assertFalse(bb.failed_due_to_status_sync(
            {"timed_out": True, "exit_code": None, "stdout": "", "stderr": ""}))
        self.assertFalse(bb.failed_due_to_status_sync(
            {"timed_out": False, "exit_code": 127, "stdout": "", "stderr": "no bb"}))
        self.assertFalse(bb.failed_due_to_status_sync(
            {"timed_out": False, "exit_code": 1,
             "stdout": "AssertionError: 1 != 0", "stderr": ""}))

    def test_self_heal_status_sync_commits_only_declared_status_outputs(self):
        """The gate commits STATUS.edn and every generated output, nothing else."""
        bb = self._load_runner_module()
        with tempfile.TemporaryDirectory() as d:
            wt = pathlib.Path(d)
            generated = wt / "docs" / "generated"
            generated.mkdir(parents=True)
            (wt / "STATUS.edn").write_text("{:tesseraft {:capabilities {}}}\n")
            (wt / "README.md").write_text("old readme\n")
            (generated / "CAPABILITIES.md").write_text("old markdown\n")
            (generated / "capabilities.json").write_text("{}\n")
            (wt / "unrelated.txt").write_text("keep me\n")
            regenerate = wt / "regenerate.py"
            regenerate.write_text(
                "from pathlib import Path\n"
                "root = Path.cwd()\n"
                "(root / 'README.md').write_text('new readme\\n')\n"
                "(root / 'docs/generated/CAPABILITIES.md').write_text('new markdown\\n')\n"
                "(root / 'docs/generated/capabilities.json').write_text('{\\\"ok\\\":true}\\n')\n"
            )
            bb.REGEN_COMMAND = [sys.executable, str(regenerate)]
            self._git(wt, "init", "-q")
            self._git(wt, "config", "user.name", "test")
            self._git(wt, "config", "user.email", "test@example.com")
            self.assertTrue(self._git(wt, "add", "-A").returncode == 0)
            self._git(wt, "commit", "-q", "-m", "initial")
            self.assertTrue(bb.self_heal_status_sync(wt))
            changed = self._git(wt, "diff", "--name-only", "HEAD~1")
            self.assertIn("README.md", changed.stdout)
            self.assertIn("docs/generated/CAPABILITIES.md", changed.stdout)
            self.assertIn("docs/generated/capabilities.json", changed.stdout)
            self.assertNotIn("unrelated.txt", changed.stdout)
            log = self._git(wt, "log", "--format=%s", "-1")
            self.assertIn("self-heal", log.stdout)

    @staticmethod
    def _git(wt: pathlib.Path, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["git", "-C", str(wt), *args], text=True, capture_output=True)


if __name__ == "__main__":
    unittest.main()
