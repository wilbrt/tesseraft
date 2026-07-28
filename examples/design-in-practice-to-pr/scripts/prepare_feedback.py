#!/usr/bin/env python3
import hashlib
import json
import pathlib
import re
import subprocess
import sys
from typing import Any

MAX_TEXT = 500
MAX_ISSUES = 3
MAX_CURRENT_BYTES = 4096
ISSUE_RE = re.compile(r"issues-(\d+)\.json$")


def clipped(value: Any, maximum: int = MAX_TEXT) -> str:
    text = str(value or "")
    return text if len(text) <= maximum else text[:maximum] + "…"


def diagnostic_signature(issues: list[dict[str, Any]]) -> str:
    tails = []
    for item in issues:
        lines = [line.strip() for line in str(item.get("details", "")).splitlines() if line.strip()]
        tails.append(lines[-1][-600:] if lines else "")
    normalized = re.sub(r"\bline \d+\b", "line #", "\n".join(tails))
    return hashlib.sha256(normalized.encode()).hexdigest()


def failure_class(issues: list[dict[str, Any]]) -> str:
    sources = {str(item.get("source", "")) for item in issues}
    text = "\n".join(f"{item.get('title', '')}\n{item.get('details', '')}" for item in issues).lower()
    if "deterministic-validation" in sources and any(marker in text for marker in ("no such file or directory", "can't open file", "cannot find")):
        return "validation-entrypoint-missing"
    if "code-review" in sources:
        return "semantic-review"
    if "deterministic-validation" in sources:
        return "deterministic-validation"
    if any(source in sources for source in ("implementation", "execution")):
        return "implementation"
    return sorted(sources)[0] if sources else "workflow"


def issue_candidates(run_dir: pathlib.Path) -> list[tuple[int, int, pathlib.Path]]:
    priority = {"execution": 1, "validation": 2, "review": 3}
    found = []
    for area, rank in priority.items():
        for path in (run_dir / area).glob("issues-*.json"):
            match = ISSUE_RE.search(path.name)
            if match:
                found.append((int(match.group(1)), rank, path))
    return sorted(found)


def work_fingerprint(worktree: pathlib.Path | None) -> dict[str, str]:
    if not worktree or not worktree.is_dir():
        return {"head": "", "changes": "", "fingerprint": ""}
    def git(*args: str) -> str:
        result = subprocess.run(["git", *args], cwd=worktree, text=True, capture_output=True, timeout=10)
        return result.stdout.strip() if result.returncode == 0 else ""
    head = git("rev-parse", "HEAD")
    changes = git("status", "--short")
    digest = hashlib.sha256(f"{head}\n{changes}".encode()).hexdigest()
    return {"head": head, "changes": clipped(changes, 600), "fingerprint": digest}


def main() -> None:
    request = json.load(sys.stdin)
    run = request.get("run", {})
    run_dir = pathlib.Path(request["paths"]["run_dir"]).resolve()
    candidates = issue_candidates(run_dir)
    if not candidates:
        issues: list[dict[str, Any]] = [{"source": "workflow", "title": "No current issue artifact", "details": "A failed node did not provide a current issue artifact.", "acceptance_criteria": "The failed node writes structured current issues."}]
        source_path = None
        source_round = int(run.get("round", 1)) - 1
    else:
        source_round, _, source_path = candidates[-1]
        loaded = json.loads(source_path.read_text())
        issues = loaded if isinstance(loaded, list) else []
        if not issues:
            issues = [{"source": "workflow", "title": "Empty current issue artifact", "details": "The newest issue artifact was empty.", "acceptance_criteria": "The failed node writes one actionable issue."}]
    compact_issues = [{
        "source": clipped(item.get("source"), 100),
        "severity": clipped(item.get("severity"), 40),
        "title": clipped(item.get("title"), 240),
        "details": clipped(item.get("details")),
        "acceptance_criteria": clipped(item.get("acceptance_criteria"), 300),
    } for item in issues[:MAX_ISSUES] if isinstance(item, dict)]
    signature = diagnostic_signature(compact_issues)
    identity = [{k: item.get(k) for k in ("source", "title", "acceptance_criteria")} for item in compact_issues]
    failure_fingerprint = hashlib.sha256(json.dumps({"issues": identity, "diagnostic_signature": signature}, sort_keys=True).encode()).hexdigest()
    classified_as = failure_class(compact_issues)
    worktree_raw = run.get("worktree-dir")
    work = work_fingerprint(pathlib.Path(worktree_raw).resolve() if worktree_raw else None)
    history_path = run_dir / "feedback/history.json"
    try:
        history = json.loads(history_path.read_text()) if history_path.exists() else []
    except Exception:
        history = []
    if not isinstance(history, list):
        history = []
    previous = history[-1] if history else None
    repeated = 1
    for item in reversed(history):
        if item.get("failure_fingerprint") != failure_fingerprint:
            break
        repeated += 1
    class_repeated = 1
    for item in reversed(history):
        if item.get("failure_class") != classified_as:
            break
        class_repeated += 1
    unchanged_work = bool(previous and previous.get("work_fingerprint") == work["fingerprint"])
    supervision_count = len(list((run_dir / "supervision").glob("status-*.json")))
    budget = request.get("node", {}).get("inputs", {}).get("correction-budget", 8)
    if not isinstance(budget, int) or isinstance(budget, bool) or budget < 1:
        raise ValueError("correction-budget must be a positive integer")
    current_round = int(run.get("round", 1))
    if current_round > budget:
        route = "intervene"
    elif (repeated >= 2 or unchanged_work) and supervision_count >= 2:
        route = "intervene"
    elif repeated >= 2 or unchanged_work:
        route = "supervise"
    else:
        route = "continue"
    entry = {
        "round": source_round,
        "source_path": str(source_path.relative_to(run_dir)) if source_path else None,
        "failure_fingerprint": failure_fingerprint,
        "diagnostic_signature": signature,
        "failure_class": classified_as,
        "work_fingerprint": work["fingerprint"],
        "head": work["head"],
        "route": route,
    }
    history = (history + [entry])[-20:]
    current = {
        "version": 1,
        "round": source_round,
        "source_path": entry["source_path"],
        "failure_fingerprint": failure_fingerprint,
        "diagnostic_signature": signature,
        "failure_class": classified_as,
        "repeat_count": repeated,
        "class_repeat_count": class_repeated,
        "work": work,
        "unchanged_work": unchanged_work,
        "supervision_count": supervision_count,
        "route": route,
        "issues": compact_issues,
    }
    encoded = json.dumps(current, indent=2) + "\n"
    if len(encoded.encode()) > MAX_CURRENT_BYTES:
        current["issues"] = current["issues"][:1]
        current["issues"][0]["details"] = clipped(current["issues"][0]["details"], 240)
        current["work"]["changes"] = clipped(current["work"]["changes"], 240)
        encoded = json.dumps(current, indent=2) + "\n"
    if len(encoded.encode()) > MAX_CURRENT_BYTES:
        raise ValueError("compact feedback exceeds 4096-byte contract")
    current_path = run_dir / "feedback/current.json"
    current_path.parent.mkdir(parents=True, exist_ok=True)
    current_path.write_text(encoded)
    history_path.write_text(json.dumps(history, indent=2) + "\n")
    json.dump({"ok": True, "status": "pass", "route": route, "summary": f"current feedback routes to {route}", "outputs": {"current": "feedback/current.json", "history": "feedback/history.json"}}, sys.stdout)
    print()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"prepare feedback error: {exc}", file=sys.stderr)
        raise SystemExit(2)
