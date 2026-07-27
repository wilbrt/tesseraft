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
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "examples" / "deterministic-code-review-loop"
WORKFLOW = PACKAGE / "workflow.edn"
BB_RUNNER = PACKAGE / "scripts" / "run_bb_test.py"
PW_RUNNER = PACKAGE / "scripts" / "run_playwright.py"
GENERATE_STATUS = ROOT / "scripts" / "generate_status.clj"
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

    def test_self_heal_status_sync_regenerates_and_commits_readme_only(self):
        """A drift between STATUS.edn and README is regenerated+committed by self_heal_status_sync.

        Uses a throwaway git repo with a minimal but valid STATUS.edn and a
        hand-written (out-of-order) README STATUS section, so `bb status`
        reproduces the drift the gate self-heals. Only README.md + STATUS.edn
        are staged; the generator is the repo's own scripts/generate_status.clj.
        """
        bb = self._load_runner_module()
        begin = "<!-- BEGIN STATUS \u2014 generated from STATUS.edn by `bb status`. Do not edit by hand. -->"
        end = "<!-- END STATUS -->"
        status_edn = "{:tesseraft\n {:capabilities\n  {:foo {:status :implemented\n          :summary \"Foo capability.\"\n          :evidence [\"src/foo.clj\"]}\n   :bar {:status :implemented\n          :summary \"Bar capability.\"\n          :evidence [\"src/bar.clj\"]}}}}\n"
        # README section deliberately in the WRONG order (bar before foo) so the
        # generator must rewrite it to declared order (foo, then bar).
        readme = (
            "# title\n\n"
            f"{begin}\nImplemented:\n\n"
            "- **bar** (implemented) \u2014 Bar capability.\n"
            "  _Evidence:_ src/bar.clj\n"
            "- **foo** (implemented) \u2014 Foo capability.\n"
            "  _Evidence:_ src/foo.clj\n"
            f"\n{end}\n\nrest\n"
        )
        with tempfile.TemporaryDirectory() as d:
            wt = pathlib.Path(d)
            (wt / "STATUS.edn").write_text(status_edn)
            (wt / "README.md").write_text(readme)
            # Mirror the repo's real bb.edn :status task so `bb status` regenerates
            # README from STATUS.edn exactly as the worktree does in a real run.
            (wt / "scripts").mkdir()
            (wt / "scripts" / "generate_status.clj").write_text(GENERATE_STATUS.read_text())
            (wt / "bb.edn").write_text(
                "{:tasks\n {status {:doc \"Regenerate README status section from STATUS.edn\"\n"
                "         :task (apply shell \"bb\" \"scripts/generate_status.clj\" *command-line-args*)}}}\n"
            )
            env = dict(os.environ)
            self._git(wt, "init", "-q")
            self._git(wt, "config", "user.name", "test")
            self._git(wt, "config", "user.email", "test@example.com")
            self.assertTrue(self._git(wt, "add", "-A").returncode == 0)
            self._git(wt, "commit", "-q", "-m", "initial")
            # Introduce drift by hand-editing README order is already wrong vs generator.
            self.assertTrue(bb.self_heal_status_sync(wt))
            changed = self._git(wt, "diff", "--name-only", "HEAD~1", "--", "README.md", "STATUS.edn")
            self.assertIn("README.md", changed.stdout)
            self.assertNotIn("bb.edn", changed.stdout)
            log = self._git(wt, "log", "--format=%s", "-1")
            self.assertIn("self-heal", log.stdout)
            # Re-check: the section now matches the generator (idempotent regenerate).
            check = subprocess.run(
                ["bb", str(GENERATE_STATUS), "--check"], cwd=wt,
                text=True, capture_output=True, env=env,
            )
            self.assertEqual(check.returncode, 0, check.stderr or check.stdout)

    @staticmethod
    def _git(wt: pathlib.Path, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["git", "-C", str(wt), *args], text=True, capture_output=True)


if __name__ == "__main__":
    unittest.main()