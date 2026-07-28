#!/usr/bin/env python3
import json
import pathlib
import re
import subprocess
import sys

MAX_BODY_BYTES = 16_000


def newest(directory: pathlib.Path, pattern: str) -> pathlib.Path | None:
    paths = list(directory.glob(pattern))
    return max(paths, key=lambda p: p.stat().st_mtime_ns) if paths else None


def read(path: pathlib.Path | None, limit: int) -> str:
    if not path or not path.exists():
        return "Not available."
    text = path.read_text(errors="replace").strip()
    return text if len(text) <= limit else text[:limit] + "\n\n[truncated]"


def section(markdown: str, heading: str, limit: int) -> str:
    match = re.search(rf"^#+\s+{re.escape(heading)}\s*$\n(.*?)(?=^#+\s+|\Z)", markdown, re.MULTILINE | re.DOTALL | re.IGNORECASE)
    if not match:
        return "Not available."
    text = match.group(1).strip()
    return text if len(text) <= limit else text[:limit] + "\n\n[truncated]"


def main() -> None:
    request = json.load(sys.stdin)
    run = request.get("run", {})
    run_dir = pathlib.Path(request["paths"]["run_dir"]).resolve()
    worktree = pathlib.Path(run["worktree-dir"]).resolve()
    title = (run_dir / "design/pr-title.txt").read_text().strip()
    if not title or len(title) > 100 or "\n" in title:
        raise ValueError("design PR title is invalid")
    base = request.get("inputs", {}).get("base-branch", "main")
    diff = subprocess.run(["git", "diff", "--stat", f"{base}...HEAD"], cwd=worktree, text=True, capture_output=True, timeout=15)
    if diff.returncode != 0:
        raise ValueError("cannot derive PR diff summary")
    brief = read(run_dir / "design/brief.md", 9000)
    validation = read(newest(run_dir / "validation", "summary-*.json"), 2200)
    review_text = read(newest(run_dir / "review", "report-*.md"), 2800)
    body = "\n".join([
        "## Summary", "", section(brief, "Description", 1200),
        "", "## Problem", "", section(brief, "Problem", 1200),
        "", "## Approach and scope", "", section(brief, "Decision and tradeoffs", 1800),
        "", section(brief, "Scope", 1200),
        "", "## Validation", "", f"```json\n{validation}\n```",
        "", "## Independent review", "", review_text,
        "", "## Diff summary", "", f"```text\n{diff.stdout.strip()}\n```", "",
    ])
    if len(body.encode()) > MAX_BODY_BYTES:
        raise ValueError("assembled PR body exceeds 16000-byte contract")
    pr_dir = run_dir / "pr"
    pr_dir.mkdir(parents=True, exist_ok=True)
    (pr_dir / "pr-title.txt").write_text(title + "\n")
    (pr_dir / "pr-body.md").write_text(body)
    json.dump({"ok": True, "status": "pass", "outputs": {"title": "pr/pr-title.txt", "body": "pr/pr-body.md"}}, sys.stdout)
    print()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"assemble PR error: {exc}", file=sys.stderr)
        raise SystemExit(2)
