#!/usr/bin/env python3
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
PACKAGE = ROOT / "examples" / "design-in-practice-to-pr"
WORKFLOW = PACKAGE / "workflow.edn"
SCRIPTS = PACKAGE / "scripts"


class DesignInPracticeWorkflowTest(unittest.TestCase):
    def invoke(self, script, request, cwd=None):
        return subprocess.run(
            [sys.executable, str(SCRIPTS / script)], input=json.dumps(request),
            text=True, capture_output=True, cwd=cwd or PACKAGE,
        )

    def test_workflow_lints_strict_without_diagnostics(self):
        result = subprocess.run(
            [str(ROOT / "bin" / "tesseraft"), "lint", str(WORKFLOW), "--format", "json", "--strict"],
            cwd=ROOT, text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr or result.stdout)
        report = json.loads(result.stdout)
        self.assertTrue(report["ok"])
        self.assertEqual(report["diagnostics"], [])

    def test_graph_is_bounded_deterministic_first_and_has_no_pr_agent(self):
        workflow = WORKFLOW.read_text()
        self.assertIn(':max-rounds 12', workflow)
        self.assertIn(':inputs {:correction-budget 8}', workflow)
        self.assertIn(':command ["./scripts/run_validation.py"]', workflow)
        self.assertIn(':command ["./scripts/prepare_feedback.py"]', workflow)
        self.assertIn('{:when {:route "supervise"} :next :supervisor}', workflow)
        self.assertIn('{:when {:route "intervene"} :next :intervention}', workflow)
        self.assertIn(':command ["./scripts/assemble_pr.py"]', workflow)
        self.assertNotIn(':merge-issues', workflow)
        self.assertNotIn(':title "Draft PR', workflow)
        self.assertEqual(workflow.count(':executor :claude-code'), 4)
        self.assertEqual(workflow.count(':model "claude-opus-5"'), 3)
        self.assertEqual(workflow.count(':model "claude-sonnet-5"'), 1)
        self.assertNotIn(':executor :pi-cli', workflow)
        self.assertNotIn(':provider ', workflow)
        self.assertNotIn(':thinking ', workflow)
        for state in ("design", "implement", "review"):
            prompt = (PACKAGE / "prompts" / f"{state}.md.tmpl").read_text()
            self.assertIn("Testing is NOT your job", prompt)
            self.assertIn("Do NOT run tests", prompt)

    def valid_design(self, run_dir):
        design = run_dir / "design"
        design.mkdir(parents=True)
        headings = [
            "Title", "Description", "Problem", "Evidence", "Use cases",
            "Approaches and criteria", "Decision and tradeoffs", "Scope",
            "Implementation plan", "Validation", "Risks and unknowns",
        ]
        (design / "brief.md").write_text("\n\n".join(f"## {x}\nvalue" for x in headings) + "\n")
        (design / "validation-plan.json").write_text(json.dumps({
            "version": 1,
            "tiers": [
                {"id": "focused", "checks": [{"id": "focused", "command": [sys.executable, "-c", "pass"], "timeout_seconds": 10}]},
                {"id": "repository", "checks": [{"id": "repo", "command": [sys.executable, "-c", "pass"], "timeout_seconds": 10}]},
            ],
        }))
        (design / "branch-name.txt").write_text("feature/valid-design\n")
        (design / "pr-title.txt").write_text("Add a valid design\n")

    def test_design_check_accepts_compact_complete_contract_and_rejects_bad_order(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = pathlib.Path(tmp)
            self.valid_design(run_dir)
            request = {"paths": {"run_dir": str(run_dir)}}
            passed = self.invoke("check_design.py", request)
            self.assertEqual(passed.returncode, 0, passed.stderr)
            self.assertEqual(json.loads(passed.stdout)["status"], "pass")
            plan = json.loads((run_dir / "design/validation-plan.json").read_text())
            plan["tiers"].reverse()
            (run_dir / "design/validation-plan.json").write_text(json.dumps(plan))
            failed = self.invoke("check_design.py", request)
            self.assertEqual(failed.returncode, 0, failed.stderr)
            self.assertEqual(json.loads(failed.stdout)["status"], "fail")
            report = json.loads((run_dir / "design/check-current.json").read_text())
            self.assertTrue(any("ordered" in error for error in report["errors"]))

    def test_validation_short_circuits_before_expensive_tier(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            run_dir, worktree = root / "run", root / "worktree"
            (run_dir / "design").mkdir(parents=True)
            worktree.mkdir()
            marker = root / "expensive-ran"
            (run_dir / "design/validation-plan.json").write_text(json.dumps({
                "version": 1,
                "tiers": [
                    {"id": "focused", "checks": [{"id": "fail", "command": [sys.executable, "-c", "import sys; print('focused failure'); sys.exit(7)"], "timeout_seconds": 10}]},
                    {"id": "browser", "checks": [{"id": "expensive", "command": [sys.executable, "-c", f"import pathlib; pathlib.Path({str(marker)!r}).write_text('ran')"], "timeout_seconds": 10}]},
                ],
            }))
            request = {"run": {"round": 2, "worktree-dir": str(worktree)}, "paths": {"run_dir": str(run_dir)}}
            result = self.invoke("run_validation.py", request)
            self.assertEqual(result.returncode, 0, result.stderr)
            response = json.loads(result.stdout)
            self.assertEqual(response["status"], "fail")
            self.assertFalse(marker.exists())
            summary = json.loads((run_dir / "validation/summary-2.json").read_text())
            self.assertEqual([x["id"] for x in summary["checks_run"]], ["fail"])
            self.assertIn("focused failure", (run_dir / "validation/issues-2.json").read_text())

    def init_repo(self, path):
        path.mkdir()
        subprocess.run(["git", "init", "-q", "-b", "main"], cwd=path, check=True)
        subprocess.run(["git", "config", "user.name", "Test"], cwd=path, check=True)
        subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=path, check=True)
        (path / "README.md").write_text("seed\n")
        subprocess.run(["git", "add", "README.md"], cwd=path, check=True)
        subprocess.run(["git", "commit", "-q", "-m", "seed"], cwd=path, check=True)

    def test_feedback_is_compact_and_routes_repeat_to_supervision_then_intervention(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            run_dir, repo = root / "run", root / "repo"
            (run_dir / "validation").mkdir(parents=True)
            self.init_repo(repo)
            issue = [{"source": "deterministic-validation", "severity": "major", "title": "same failure", "details": "x" * 5000, "acceptance_criteria": "pass the check"}]
            (run_dir / "validation/issues-1.json").write_text(json.dumps(issue))
            request = {"run": {"round": 2, "worktree-dir": str(repo)}, "paths": {"run_dir": str(run_dir)}}
            first = json.loads(self.invoke("prepare_feedback.py", request).stdout)
            self.assertEqual(first["route"], "continue")
            second = json.loads(self.invoke("prepare_feedback.py", request).stdout)
            self.assertEqual(second["route"], "supervise")
            current = run_dir / "feedback/current.json"
            self.assertLessEqual(current.stat().st_size, 4096)
            supervision = run_dir / "supervision"
            supervision.mkdir()
            (supervision / "status-2.json").write_text("{}")
            (supervision / "status-3.json").write_text("{}")
            third = json.loads(self.invoke("prepare_feedback.py", request).stdout)
            self.assertEqual(third["route"], "intervene")

    def test_feedback_classifies_missing_validation_entrypoints(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            run_dir, repo = root / "run", root / "repo"
            (run_dir / "validation").mkdir(parents=True)
            self.init_repo(repo)
            issue = [{"source": "deterministic-validation", "severity": "major", "title": "focused check missing", "details": "python3: can't open file /repo/test/missing.py: No such file or directory", "acceptance_criteria": "declared check passes"}]
            (run_dir / "validation/issues-1.json").write_text(json.dumps(issue))
            request = {"run": {"round": 2, "worktree-dir": str(repo)}, "paths": {"run_dir": str(run_dir)}}
            result = self.invoke("prepare_feedback.py", request)
            self.assertEqual(result.returncode, 0, result.stderr)
            current = json.loads((run_dir / "feedback/current.json").read_text())
            self.assertEqual(current["failure_class"], "validation-entrypoint-missing")
            self.assertEqual(current["class_repeat_count"], 1)
            history = json.loads((run_dir / "feedback/history.json").read_text())
            self.assertEqual(history[0]["failure_class"], "validation-entrypoint-missing")

    def test_changed_diagnostics_do_not_trigger_supervision_and_soft_budget_intervenes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            run_dir, repo = root / "run", root / "repo"
            (run_dir / "validation").mkdir(parents=True)
            self.init_repo(repo)
            issue_path = run_dir / "validation/issues-1.json"
            base = {"source": "deterministic-validation", "severity": "major", "title": "focused check failed", "acceptance_criteria": "focused check passes"}
            issue_path.write_text(json.dumps([{**base, "details": "Traceback line 10\nAssertionError: first assertion"}]))
            request = {"run": {"round": 2, "worktree-dir": str(repo)}, "node": {"inputs": {"correction-budget": 8}}, "paths": {"run_dir": str(run_dir)}}
            first = json.loads(self.invoke("prepare_feedback.py", request).stdout)
            first_current = json.loads((run_dir / "feedback/current.json").read_text())
            self.assertEqual(first["route"], "continue")
            (repo / "progress.txt").write_text("progress\n")
            subprocess.run(["git", "add", "progress.txt"], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-q", "-m", "progress"], cwd=repo, check=True)
            issue_path.write_text(json.dumps([{**base, "details": "Traceback line 20\nAssertionError: second assertion"}]))
            request["run"]["round"] = 3
            second = json.loads(self.invoke("prepare_feedback.py", request).stdout)
            second_current = json.loads((run_dir / "feedback/current.json").read_text())
            self.assertEqual(second["route"], "continue")
            self.assertNotEqual(first_current["failure_fingerprint"], second_current["failure_fingerprint"])
            self.assertNotEqual(first_current["diagnostic_signature"], second_current["diagnostic_signature"])
            request["run"]["round"] = 9
            over_budget = json.loads(self.invoke("prepare_feedback.py", request).stdout)
            self.assertEqual(over_budget["route"], "intervene")

    def test_pr_assembly_leads_with_full_design_not_latest_correction(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            run_dir, repo = root / "run", root / "repo"
            self.init_repo(repo)
            subprocess.run(["git", "switch", "-q", "-c", "feature/pr-assembly"], cwd=repo, check=True)
            (repo / "feature.txt").write_text("complete change\n")
            subprocess.run(["git", "add", "feature.txt"], cwd=repo, check=True)
            subprocess.run(["git", "commit", "-q", "-m", "complete change"], cwd=repo, check=True)
            for directory in ("design", "execution", "validation", "review"):
                (run_dir / directory).mkdir(parents=True)
            (run_dir / "design/pr-title.txt").write_text("Deliver the complete change\n")
            (run_dir / "design/brief.md").write_text(
                "# Title\nComplete change\n\n# Description\nFull user-visible delivery.\n\n"
                "# Problem\nUsers lack the complete behavior.\n\n# Decision and tradeoffs\nUse the bounded approach.\n\n"
                "# Scope\nInclude the complete contract.\n"
            )
            (run_dir / "execution/summary-9.md").write_text("Only fixed the final tiny correction.\n")
            (run_dir / "validation/summary-9.json").write_text('{"status":"pass"}\n')
            (run_dir / "review/report-9.md").write_text("# Review\nPASS: complete diff reviewed.\n")
            request = {"run": {"worktree-dir": str(repo)}, "inputs": {"base-branch": "main"}, "paths": {"run_dir": str(run_dir)}}
            result = self.invoke("assemble_pr.py", request)
            self.assertEqual(result.returncode, 0, result.stderr)
            body = (run_dir / "pr/pr-body.md").read_text()
            self.assertIn("## Summary\n\nFull user-visible delivery.", body)
            self.assertIn("## Problem\n\nUsers lack the complete behavior.", body)
            self.assertNotIn("## Final correction", body)
            self.assertNotIn("Only fixed the final tiny correction.", body)
            self.assertLessEqual(len(body.encode()), 16000)

            (run_dir / "review/report-9.md").write_text(
                "# Review\n\n## Verdict: PASS\n\nThe complete branch implements every user-visible capability.\n\nValidation passed.\n"
            )
            request["inputs"]["branch"] = "feature/pr-assembly"
            replacement = self.invoke("assemble_pr.py", request)
            self.assertEqual(replacement.returncode, 0, replacement.stderr)
            replacement_body = (run_dir / "pr/pr-body.md").read_text()
            self.assertIn("## Summary\n\nThe complete branch implements every user-visible capability.", replacement_body)
            self.assertIn("## Final correction", replacement_body)

    def test_learning_records_usage_and_distinguishes_no_pr(self):
        with tempfile.TemporaryDirectory() as tmp:
            run_dir = pathlib.Path(tmp)
            sessions = run_dir / "pi-sessions"
            sessions.mkdir()
            (sessions / "one.jsonl").write_text(json.dumps({"message": {"usage": {"input": 10, "output": 2, "cacheRead": 5, "reasoning": 1, "totalTokens": 18, "cost": {"total": 0.1}}}}) + "\n")
            claude_sessions = run_dir / "claude-sessions"
            claude_sessions.mkdir()
            (claude_sessions / "design.txt").write_text("claude-code session marker\n")
            request = {"run": {"id": "learning", "round": 3, "status": "blocked"}, "paths": {"run_dir": str(run_dir)}, "node": {"id": "record-learning"}}
            result = self.invoke("record_learning.py", request)
            self.assertEqual(result.returncode, 0, result.stderr)
            response = json.loads(result.stdout)
            self.assertFalse(response["pr_created"])
            summary = json.loads((run_dir / "learning/run-summary.json").read_text())
            self.assertEqual(summary["usage"]["sessions"], 2)
            self.assertEqual(summary["usage"]["pi_sessions"], 1)
            self.assertEqual(summary["usage"]["claude_sessions"], 1)
            self.assertFalse(summary["usage"]["claude_token_usage_available"])
            self.assertEqual(summary["usage"]["total_tokens"], 18)
            self.assertFalse(summary["pr_created"])


if __name__ == "__main__":
    unittest.main()
