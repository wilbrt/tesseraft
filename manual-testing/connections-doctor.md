# Connections Doctor manual test

Copy-paste from the repo root of the feature worktree. Do not paste or capture
raw token values in screenshots or logs.

```sh
set -euo pipefail
npm run web:build
node web/dist-server/server.js --host 127.0.0.1 --port 5050
```

In a second terminal:

```sh
set -euo pipefail
BASE=http://127.0.0.1:5050
curl -sS "$BASE/api/projects/default/doctor" | python3 - <<'PY'
import json, sys
body = json.load(sys.stdin)
print(json.dumps({"project_id": body["project_id"], "summary": body["summary"]}, indent=2))
assert body["project_id"] == "default"
assert [c["id"] for c in body["checks"]] == [
  "github-credential", "github-auth", "jira-base-url", "jira-credential",
  "pi-provider-model", "git-author", "repository-root", "pinga",
  "workflow-discovery", "runs-root"
]
assert all(c["status"] in {"ready", "not-configured", "unreachable", "invalid"} for c in body["checks"])
assert all(c["mode"] in {"static", "read-only"} for c in body["checks"])
text = json.dumps(body)
for forbidden in ["SECRET_SENTINEL", "stdout", "stderr", "GH_TOKEN", "GITHUB_TOKEN", "JIRA_TOKEN"]:
    assert forbidden not in text, forbidden
PY
```

Browser check:

1. Open <http://127.0.0.1:5050/>.
2. Select **Settings**.
3. Confirm **Connections Doctor** appears and shows summary counts, status text,
   check mode labels (Static configuration / Read-only check), summaries, and
   remediation where applicable.
4. Click **Run checks** and confirm the panel refreshes for the selected project.
5. Switch projects from the header selector if another project exists and confirm
   the request path is `/api/projects/<project-id>/doctor` and no statuses or
   paths from the previous project are shown.

Pass criteria:

- Only statuses `ready`, `not-configured`, `unreachable`, or `invalid` appear.
- Jira/Pinga checks are described as static/non-executing; Pi is local catalog
  only; GitHub/Git checks are read-only.
- No raw token, token preview, subprocess stdout/stderr, or environment dump is
  visible in API output, browser UI, terminal logs, or screenshots.
