#!/usr/bin/env python3
import json
import pathlib
import subprocess
import sys

MAX_ENTRIES = 80


def run(repo: pathlib.Path, *args: str) -> str:
    result = subprocess.run(args, cwd=repo, text=True, capture_output=True, timeout=10)
    return result.stdout.strip() if result.returncode == 0 else ""


def main() -> None:
    request = json.load(sys.stdin)
    repo = pathlib.Path(request["paths"]["repo_root"]).resolve()
    run_dir = pathlib.Path(request["paths"]["run_dir"]).resolve()
    if not repo.is_dir():
        raise ValueError(f"repository root does not exist: {repo}")
    entries = sorted(p.name for p in repo.iterdir() if p.name not in {".git", "node_modules", ".agent-runs", ".agent-worktrees"})[:MAX_ENTRIES]
    manifests = [name for name in ("bb.edn", "package.json", "pyproject.toml", "Cargo.toml", "go.mod", "Makefile") if (repo / name).exists()]
    guidance = [name for name in ("README.md", "SPEC.md", "AGENTS.md", "CONTRIBUTING.md", "docs/CODE_STYLE.md") if (repo / name).exists()]
    context = {
        "version": 1,
        "repository_root": str(repo),
        "base_branch": request.get("inputs", {}).get("base-branch", "main"),
        "git_head": run(repo, "git", "rev-parse", "HEAD"),
        "git_branch": run(repo, "git", "branch", "--show-current"),
        "git_status": run(repo, "git", "status", "--short"),
        "top_level_entries": entries,
        "manifests": manifests,
        "guidance_files": guidance,
        "workflow_lessons": "context/prior-run-lessons.md",
    }
    out = (run_dir / "context/repository.json").resolve()
    out.relative_to(run_dir)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(context, indent=2) + "\n")
    lessons_source = pathlib.Path(__file__).resolve().parents[1] / "knowledge/prior-run-lessons.md"
    lessons_out = (run_dir / "context/prior-run-lessons.md").resolve()
    lessons_out.relative_to(run_dir)
    lessons_out.write_text(lessons_source.read_text())
    json.dump({"ok": True, "status": "pass", "outputs": {"repository-context": "context/repository.json", "prior-run-lessons": "context/prior-run-lessons.md"}}, sys.stdout)
    print()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"collect context error: {exc}", file=sys.stderr)
        raise SystemExit(2)
