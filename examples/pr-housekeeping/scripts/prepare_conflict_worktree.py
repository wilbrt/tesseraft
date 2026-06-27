#!/usr/bin/env python3
import json
import pathlib
import re
import subprocess
import sys

from path_utils import resolve_repo_root


def run(cmd, cwd=None, check=True):
    return subprocess.run(cmd, cwd=cwd, text=True, capture_output=True, check=check)


def safe_component(value):
    value = re.sub(r"[^A-Za-z0-9._-]+", "-", str(value)).strip("-")
    return value or "pr"


def main():
    request = json.load(sys.stdin)
    inputs = request.get("inputs", {})
    repo_root = resolve_repo_root(request)
    run_dir = pathlib.Path(request["paths"]["run_dir"])
    target = int(inputs.get("target-pr") or (run_dir / "conflict-repair" / "target-pr.txt").read_text().strip())
    base_branch = inputs.get("base-branch") or "main"

    pr_raw = run([
        "gh", "pr", "view", str(target),
        "--json", "number,title,url,headRefName,baseRefName,headRepositoryOwner,headRepository,isCrossRepository"
    ], cwd=repo_root).stdout
    pr = json.loads(pr_raw)
    if pr.get("isCrossRepository"):
        raise SystemExit(f"Refusing to repair cross-repository PR #{target}; pushing safely requires same-repository branch support")

    head = pr["headRefName"]
    base = pr.get("baseRefName") or base_branch
    repair_branch = f"pr-housekeeping/repair-{target}-{safe_component(head)}-{safe_component(request['run']['id'])}"
    worktree = repo_root / ".agent-worktrees" / f"pr-housekeeping-{safe_component(request['run']['id'])}-pr-{target}"

    run(["git", "fetch", "origin", f"pull/{target}/head:refs/heads/{repair_branch}"], cwd=repo_root)
    if not worktree.exists():
        worktree.parent.mkdir(parents=True, exist_ok=True)
        run(["git", "worktree", "add", str(worktree), repair_branch], cwd=repo_root)
    original_head_oid = run(["git", "rev-parse", "HEAD"], cwd=worktree).stdout.strip()

    out_dir = run_dir / "conflict-repair"
    out_dir.mkdir(parents=True, exist_ok=True)
    metadata = {
        "pr": pr,
        "target_pr": target,
        "head_ref": head,
        "base_ref": base,
        "repair_branch": repair_branch,
        "worktree": str(worktree),
        "push_refspec": f"HEAD:refs/heads/{head}",
        "original_head_oid": original_head_oid,
    }
    (out_dir / "worktree.json").write_text(json.dumps(metadata, indent=2) + "\n")
    (out_dir / "worktree-path.txt").write_text(str(worktree) + "\n")
    (out_dir / "repair-branch.txt").write_text(repair_branch + "\n")

    json.dump({
        "ok": True,
        "status": "pass",
        "branch": repair_branch,
        "worktree-dir": str(worktree),
        "outputs": {
            "worktree": "conflict-repair/worktree.json",
            "worktree-path": "conflict-repair/worktree-path.txt",
            "repair-branch": "conflict-repair/repair-branch.txt"
        }
    }, sys.stdout)
    print()


if __name__ == "__main__":
    main()
