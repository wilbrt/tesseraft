# Connections Doctor manual test

Copy-paste from the repo root of the feature worktree. Do not paste or capture
raw token values in screenshots or logs.

```sh
set -euo pipefail

# Seed a disposable explicit project so project isolation can be verified from a
# normal worktree-rooted server. The fixture stores only credential references;
# do not export the referenced variables while capturing evidence.
FIXTURE_PROJECT_ID=doctor-explicit
FIXTURE_WS=.agent-runs/manual-connections-doctor-explicit-ws
FIXTURE_MANIFEST=.tesseraft/projects/${FIXTURE_PROJECT_ID}.json
cleanup() {
  rm -rf "$FIXTURE_WS" "$FIXTURE_MANIFEST"
}
trap cleanup EXIT INT TERM
cleanup
mkdir -p "$FIXTURE_WS/.tesseraft/workflows/manual-doctor" "$FIXTURE_WS/runs" .tesseraft/projects
cat > "$FIXTURE_WS/.tesseraft/workflows/manual-doctor/workflow.edn" <<'EOF'
{:api-version "tesseraft.workflow/v1"
 :kind :workflow
 :metadata {:name "manual-doctor" :title "Manual Doctor"}
 :defaults {:max-rounds 1 :state-timeout "1m"}
 :policies {:require-timeouts true :require-max-rounds true}
 :initial :start
 :states {:start {:type :deterministic
                  :handler :noop/succeed
                  :runtime {:timeout "10s"}
                  :next :done}
          :done {:type :terminal :title "Done" :status :success}}}
EOF
cat > "$FIXTURE_MANIFEST" <<'EOF'
{
  "project_id": "doctor-explicit",
  "name": "Doctor Explicit",
  "workspace_root": ".agent-runs/manual-connections-doctor-explicit-ws",
  "runs_root": "runs",
  "discovery": {"workflow-roots": [".tesseraft/workflows"]},
  "settings": {"default-repo-root": "missing-repo-root"},
  "connections": {
    "github": {"credential-ref": "env:DOCTOR_EXPLICIT_GITHUB_TOKEN"},
    "jira": {
      "base-url": "https://doctor-explicit.invalid",
      "credential-ref": "env:DOCTOR_EXPLICIT_JIRA_TOKEN"
    }
  }
}
EOF

npm run web:build
node web/dist-server/server.js --host 127.0.0.1 --port 5050
```

In a second terminal:

```sh
set -euo pipefail
BASE=http://127.0.0.1:5050
export DEFAULT_BODY="$(curl -sS "$BASE/api/projects/default/doctor")"
export EXPLICIT_BODY="$(curl -sS "$BASE/api/projects/doctor-explicit/doctor")"
python3 - <<'PY'
import json, os
expected = [
  "github-credential", "github-auth", "jira-base-url", "jira-credential",
  "pi-provider-model", "git-author", "repository-root", "pinga",
  "workflow-discovery", "runs-root"
]
allowed_status = {"ready", "not-configured", "unreachable", "invalid"}
allowed_mode = {"static", "read-only"}
bodies = {
  "default": json.loads(os.environ["DEFAULT_BODY"]),
  "doctor-explicit": json.loads(os.environ["EXPLICIT_BODY"]),
}
for project_id, body in bodies.items():
    print(json.dumps({"project_id": body["project_id"], "summary": body["summary"]}, indent=2))
    assert body["project_id"] == project_id
    assert [c["id"] for c in body["checks"]] == expected
    assert all(c["status"] in allowed_status for c in body["checks"])
    assert all(c["mode"] in allowed_mode for c in body["checks"])
    text = json.dumps(body)
    # Credential reference names such as env:DOCTOR_EXPLICIT_GITHUB_TOKEN may
    # appear by design; raw secret values, subprocess output, and environment
    # dumps must not.
    for forbidden in ["SECRET_SENTINEL_VALUE", "stdout", "stderr", "ghp_", "token-preview"]:
        assert forbidden not in text, forbidden

def checks(body):
    return {c["id"]: c for c in body["checks"]}
default_checks = checks(bodies["default"])
explicit_checks = checks(bodies["doctor-explicit"])
assert explicit_checks["workflow-discovery"]["status"] == "ready"
assert explicit_checks["runs-root"]["status"] == "ready"
assert explicit_checks["repository-root"]["status"] == "invalid"
assert bodies["default"] != bodies["doctor-explicit"], "explicit project must have distinct doctor output"
assert "manual-connections-doctor-explicit-ws" not in json.dumps(bodies["default"]), "default response must not mention explicit workspace"
PY

curl -sS -o /tmp/doctor-missing.json -w '%{http_code}\n' "$BASE/api/projects/doctor-missing/doctor" | grep -qx '404'
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
