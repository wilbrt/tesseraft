#!/usr/bin/env python3
import importlib.util
import json
import pathlib
import subprocess
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
WORKFLOW = ROOT / "examples" / "focused-tdd-to-pr" / "workflow.edn"
SCENARIO_SCHEMA = ROOT / "examples" / "focused-tdd-to-pr" / "schemas" / "scenario-list.schema.json"
RUNNER = ROOT / "examples" / "focused-tdd-to-pr" / "scripts" / "run_validation.py"


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

    def test_workflow_encodes_bounded_current_only_hybrid(self):
        workflow = WORKFLOW.read_text()
        self.assertIn(':max-rounds 20', workflow)
        self.assertNotIn(':merge-issues', workflow)
        self.assertEqual(workflow.count(':prompt-template'), 6)
        self.assertIn(':inputs {:phase "red"', workflow)
        self.assertIn(':inputs {:phase "green"', workflow)
        self.assertIn(':inputs {:phase "regression"', workflow)
        self.assertIn('{:when {:status "no_actions"} :next :run-regression-plan}', workflow)
        self.assertIn('{:when {:status "pass"} :effects [:inc-round] :next :prepare-test}', workflow)

    def test_scenario_inventory_is_small_and_has_non_red_coverage_state(self):
        schema = json.loads(SCENARIO_SCHEMA.read_text())
        scenarios = schema["properties"]["scenarios"]
        self.assertEqual(scenarios["maxItems"], 8)
        states = scenarios["items"]["properties"]["state"]["enum"]
        self.assertEqual(states, ["pending", "complete", "regression-covered"])

    def test_regression_runner_writes_declared_validation_paths(self):
        spec = importlib.util.spec_from_file_location("focused_validation", RUNNER)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        self.assertEqual(
            module.artifact_paths("regression", 3),
            ("validation/report-3.md", "validation/issues-3.json"),
        )


if __name__ == "__main__":
    unittest.main()
