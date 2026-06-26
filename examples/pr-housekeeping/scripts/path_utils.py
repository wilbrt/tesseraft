import pathlib


def resolve_repo_root(request):
    raw = pathlib.Path(request["paths"].get("repo_root") or request.get("inputs", {}).get("repo-root") or ".")
    if raw.is_absolute():
        return raw.resolve()
    run_dir = pathlib.Path(request["paths"]["run_dir"]).resolve()
    candidate = (run_dir / raw).resolve()
    if (candidate / ".git").exists():
        return candidate
    cwd_candidate = raw.resolve()
    if (cwd_candidate / ".git").exists():
        return cwd_candidate
    return candidate
