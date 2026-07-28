#!/usr/bin/env python3
"""Contract tests for the supervised deterministic code review workflow."""

import importlib.util
import json
import pathlib
import subprocess
import sys
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "examples" / "supervised-deterministic-code-review-loop"
WORKFLOW = PACKAGE / "workflow.edn"
CADENCE = PACKAGE / "scripts" / "check_supervision.py"


class SupervisedDeterministicCodeReviewWorkflowTest(unittest.TestCase):
    def test_workflow_lints_without_diagnostics(self):
        result = subprocess.run(
            [str(ROOT / "bin" / "tesseraft"), "lint", str(WORKFLOW), "--format", "json"],
            cwd=ROOT, text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        report = json.loads(result.stdout)
        self.assertTrue(report["ok"])
        self.assertEqual(report["diagnostics"], [])

    def test_failure_cycles_route_through_periodic_supervision(self):
        workflow = WORKFLOW.read_text()
        self.assertIn(':metadata {:name "supervised-deterministic-code-review-loop"', workflow)
        self.assertIn(':supervision-check', workflow)
        self.assertIn(':command ["./scripts/check_supervision.py"]', workflow)
        self.assertIn('{:when {:route "supervise"} :next :supervisor}', workflow)
        self.assertIn('{:when {:route "continue"} :next :implement}', workflow)
        self.assertEqual(
            workflow.count(':effects [:merge-issues :inc-round] :next :supervision-check'),
            4,
            "implementation, bb, Playwright, and review failures must all pass through cadence",
        )
        self.assertNotIn(':effects [:merge-issues :inc-round] :next :implement', workflow)

    def test_supervisor_is_source_read_only_and_handoff_is_consumed(self):
        workflow = WORKFLOW.read_text()
        supervisor_block = workflow.split(':supervisor\n', 1)[1].split(';; ---- Deterministic gate 1', 1)[0]
        self.assertIn(':tools [:read :grep :find :ls :write]', supervisor_block)
        self.assertNotIn(':bash', supervisor_block)
        self.assertNotIn(':edit', supervisor_block)
        self.assertIn(':path "supervision/report-{{run.round}}.md"', supervisor_block)
        self.assertIn(':path "supervision/current.md"', supervisor_block)

        supervisor_prompt = (PACKAGE / "prompts" / "supervisor.md.tmpl").read_text()
        self.assertIn("EARLIEST DISCREPANCY", supervisor_prompt)
        self.assertIn("VALIDATED PREFIX", supervisor_prompt)
        self.assertIn("REVISED SUFFIX", supervisor_prompt)
        self.assertIn("Do NOT run tests", supervisor_prompt)
        self.assertIn("do not rely only on generic issues.json", supervisor_prompt)

        implement_prompt = (PACKAGE / "prompts" / "implement.md.tmpl").read_text()
        self.assertIn("supervision/current.md", implement_prompt)
        self.assertIn("follow its validated", implement_prompt)

    def test_cadence_routes_every_third_failed_cycle(self):
        spec = importlib.util.spec_from_file_location("supervision_cadence", CADENCE)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        routes = [module.supervision_route({"run": {"round": n}}) for n in range(1, 12)]
        self.assertEqual(
            routes,
            ["continue", "continue", "continue", "supervise", "continue", "continue",
             "supervise", "continue", "continue", "supervise", "continue"],
        )

    def test_cadence_process_contract_and_malformed_input(self):
        success = subprocess.run(
            [sys.executable, str(CADENCE)], input=json.dumps({"run": {"round": 7}}),
            cwd=ROOT, text=True, capture_output=True,
        )
        self.assertEqual(success.returncode, 0, success.stderr)
        response = json.loads(success.stdout)
        self.assertEqual(response["status"], "pass")
        self.assertEqual(response["route"], "supervise")

        malformed = subprocess.run(
            [sys.executable, str(CADENCE)], input=json.dumps({"paths": {}}),
            cwd=ROOT, text=True, capture_output=True,
        )
        self.assertNotEqual(malformed.returncode, 0)
        self.assertIn("requires run context", malformed.stderr)

    def test_all_process_scripts_are_executable(self):
        for script in (PACKAGE / "scripts").glob("*.py"):
            self.assertTrue(script.stat().st_mode & 0o111, f"script is not executable: {script}")


if __name__ == "__main__":
    unittest.main()
