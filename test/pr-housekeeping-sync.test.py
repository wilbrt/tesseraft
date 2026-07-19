#!/usr/bin/env python3
import json
import pathlib
import subprocess
import tempfile
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "examples" / "pr-housekeeping" / "scripts" / "sync_base_branch.py"


def run(*args, cwd=None):
    return subprocess.run(args, cwd=cwd, text=True, capture_output=True, check=True)


class SyncBaseBranchTest(unittest.TestCase):
    def test_fast_forwards_main_and_refuses_another_checked_out_branch(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = pathlib.Path(tmp)
            remote = root / "remote.git"
            seed = root / "seed"
            checkout = root / "checkout"
            success_run = root / "success-run"
            refusal_run = root / "refusal-run"
            success_run.mkdir()
            refusal_run.mkdir()

            run("git", "init", "--bare", "--initial-branch=main", str(remote))
            run("git", "init", "--initial-branch=main", str(seed))
            run("git", "config", "user.name", "Test", cwd=seed)
            run("git", "config", "user.email", "test@example.com", cwd=seed)
            (seed / "file.txt").write_text("one\n")
            run("git", "add", "file.txt", cwd=seed)
            run("git", "commit", "-m", "one", cwd=seed)
            run("git", "remote", "add", "origin", str(remote), cwd=seed)
            run("git", "push", "-u", "origin", "main", cwd=seed)
            run("git", "clone", str(remote), str(checkout))
            before = run("git", "rev-parse", "HEAD", cwd=checkout).stdout.strip()

            with (seed / "file.txt").open("a") as handle:
                handle.write("two\n")
            run("git", "commit", "-am", "two", cwd=seed)
            run("git", "push", "origin", "main", cwd=seed)
            expected = run("git", "rev-parse", "HEAD", cwd=seed).stdout.strip()

            request = {
                "paths": {"run_dir": str(success_run), "repo_root": str(checkout)},
                "inputs": {"repo-root": str(checkout), "base-branch": "main"},
            }
            result = subprocess.run(
                [str(SCRIPT)], input=json.dumps(request), text=True, capture_output=True, check=True
            )
            response = json.loads(result.stdout)
            record = json.loads((success_run / "housekeeping" / "base-sync.json").read_text())
            after = run("git", "rev-parse", "HEAD", cwd=checkout).stdout.strip()
            self.assertNotEqual(before, after)
            self.assertEqual(expected, after)
            self.assertTrue(response["updated"])
            self.assertEqual("ok", record["status"])

            run("git", "switch", "-c", "topic", cwd=checkout)
            request["paths"]["run_dir"] = str(refusal_run)
            refused = subprocess.run(
                [str(SCRIPT)], input=json.dumps(request), text=True, capture_output=True
            )
            refusal = json.loads((refusal_run / "housekeeping" / "base-sync.json").read_text())
            self.assertNotEqual(0, refused.returncode)
            self.assertEqual("error", refusal["status"])
            self.assertIn("must have 'main' checked out", refusal["error"])


if __name__ == "__main__":
    unittest.main()
