# Connections Doctor manual test

Copy-paste from the repo root of the feature worktree. Do not paste or capture
raw token values in screenshots or logs.

Produced workflow test servers started by Tesseraft's `:web/start-test-server`
handler seed the same disposable `doctor-explicit` project automatically. Use
the setup block below when starting a normal worktree-rooted server by hand.

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
  "workflow-discovery", "runs-root", "work-tracker-config", "work-tracker-credential"
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
assert explicit_checks["work-tracker-config"]["state"] == "absent", explicit_checks["work-tracker-config"]
assert bodies["doctor-explicit"]["work_tracker"]["state"] == "absent"
assert bodies["default"] != bodies["doctor-explicit"], "explicit project must have distinct doctor output"
assert "manual-connections-doctor-explicit-ws" not in json.dumps(bodies["default"]), "default response must not mention explicit workspace"
PY

curl -sS -o /tmp/doctor-missing.json -w '%{http_code}\n' "$BASE/api/projects/doctor-missing/doctor" | grep -qx '404'
```

### Work-tracker diagnosis states (WT4)

Seed five disposable fixture projects — one per diagnosis state — using only
fake local manifests and non-existent credential-ref names (never real
secrets), then confirm the doctor classifies each correctly:

```sh
set -euo pipefail
PROJECTS_DIR=.tesseraft/projects
declare -A FIXTURES=(
  [wt4-doctor-absent]='{"project_id":"wt4-doctor-absent","name":"WT4 Absent","workspace_root":".","runs_root":".agent-runs","connections":{}}'
  [wt4-doctor-incomplete]='{"project_id":"wt4-doctor-incomplete","name":"WT4 Incomplete","workspace_root":".","runs_root":".agent-runs","connections":{"work-tracker":{"provider":"plane","credential-ref":"env:WT4_MANUAL_PLANE","config":{"api-base-url":"https://plane.example"}}}}'
  [wt4-doctor-invalid]='{"project_id":"wt4-doctor-invalid","name":"WT4 Invalid","workspace_root":".","runs_root":".agent-runs","connections":{"work-tracker":{"provider":"acme-unregistered","credential-ref":"env:WT4_MANUAL_ACME","config":{}}}}'
  [wt4-doctor-unresolved]='{"project_id":"wt4-doctor-unresolved","name":"WT4 Unresolved","workspace_root":".","runs_root":".agent-runs","connections":{"work-tracker":{"provider":"github-issues","credential-ref":"env:WT4_MANUAL_UNSET_TOKEN","config":{"repository":"owner/repo"}}}}'
  [wt4-doctor-ready]='{"project_id":"wt4-doctor-ready","name":"WT4 Ready","workspace_root":".","runs_root":".agent-runs","connections":{"work-tracker":{"provider":"github-issues","credential-ref":"env:WT4_MANUAL_READY_TOKEN","config":{"repository":"owner/repo"}}}}'
  [wt4-doctor-credential-invalid]='{"project_id":"wt4-doctor-credential-invalid","name":"WT4 Credential Invalid","workspace_root":".","runs_root":".agent-runs","connections":{"work-tracker":{"provider":"github-issues","credential-ref":"not-a-valid-ref","config":{"repository":"owner/repo"}}}}'
)
cleanup_fixtures() {
  for id in "${!FIXTURES[@]}"; do rm -f "$PROJECTS_DIR/$id.json"; done
}
trap cleanup_fixtures EXIT INT TERM
mkdir -p "$PROJECTS_DIR"
for id in "${!FIXTURES[@]}"; do printf '%s' "${FIXTURES[$id]}" > "$PROJECTS_DIR/$id.json"; done

# The `ready` fixture needs its referenced env var to actually resolve; export
# a throwaway, non-secret placeholder value for this local-only demonstration.
export WT4_MANUAL_READY_TOKEN=manual-demo-not-a-real-secret

npm run web:build
node web/dist-server/server.js --host 127.0.0.1 --port 5050 &
SERVER_PID=$!
sleep 1

BASE=http://127.0.0.1:5050
python3 - <<'PY'
import json, os, urllib.request
# work-tracker-config classifies provider/config only; work-tracker-credential
# classifies the credential-ref only, independent of provider/config. The two
# checks agree only when both concerns are in the same state (absent, or both
# statically ready) -- they diverge whenever exactly one concern is
# defective: wt4-doctor-incomplete and wt4-doctor-invalid both use a
# syntactically valid but unset env: ref, so the credential check reports
# "unresolved" even though the config check reports "incomplete"/"invalid";
# wt4-doctor-unresolved has a fully valid config but an unset ref (config
# ready, credential unresolved); wt4-doctor-credential-invalid mirrors that
# with a fully valid config but a malformed ref (config ready, credential
# invalid). See docs/CONTROL_PLANE_API.md WT4 for the authoritative rule.
expected = {
  "wt4-doctor-absent": {"combined": "absent", "config": "absent", "credential": "absent"},
  "wt4-doctor-incomplete": {"combined": "incomplete", "config": "incomplete", "credential": "unresolved"},
  "wt4-doctor-invalid": {"combined": "invalid", "config": "invalid", "credential": "unresolved"},
  "wt4-doctor-unresolved": {"combined": "unresolved", "config": "ready", "credential": "unresolved"},
  "wt4-doctor-credential-invalid": {"combined": "invalid", "config": "ready", "credential": "invalid"},
  "wt4-doctor-ready": {"combined": "ready", "config": "ready", "credential": "ready"},
}
for project_id, want in expected.items():
    body = json.loads(urllib.request.urlopen(f"http://127.0.0.1:5050/api/projects/{project_id}/doctor").read())
    got_combined = body["work_tracker"]["state"]
    config_check = next(c for c in body["checks"] if c["id"] == "work-tracker-config")
    credential_check = next(c for c in body["checks"] if c["id"] == "work-tracker-credential")
    assert got_combined == want["combined"], f"{project_id}: expected {want['combined']}, got {got_combined} ({body['work_tracker']})"
    assert config_check["state"] == want["config"], config_check
    assert credential_check["state"] == want["credential"], credential_check
    print(f"{project_id}: work_tracker={got_combined} config={config_check['state']} credential={credential_check['state']} OK")
PY

kill "$SERVER_PID"
wait "$SERVER_PID" 2>/dev/null || true
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
6. In the "Projects and connections" card, confirm the **Work tracker** editor:
   the provider `<select>` includes a **No tracker** option; choosing a
   provider (e.g. `plane`) renders that provider's fields (fetched from
   `/api/work-tracker-providers`, not a fixed Plane-only list) plus a
   credential-reference field; **Save tracker** persists it and **Clear
   tracker** removes it (clicking Clear again is a no-op, not an error).
   Confirm no credential value or preview is ever rendered — only the masked
   credential-state pill.
7. Re-select one of the `wt4-doctor-*` fixture projects from step above (still
   running) and confirm the Connections Doctor shows a second state pill on
   the two work-tracker checks (`No tracker` / `Incomplete` / `Invalid config`
   / `Unresolved credential` / `Statically ready`) and a report-level "Work
   tracker verdict" line. For `wt4-doctor-incomplete` and `wt4-doctor-invalid`,
   confirm the two check pills *differ*: `work-tracker-config` shows
   `Incomplete`/`Invalid config` while `work-tracker-credential` shows
   `Unresolved credential` (the seeded `env:` ref is well-formed but unset, so
   the credential check classifies independently of the config defect). For
   `wt4-doctor-unresolved`, confirm `work-tracker-config` shows
   `Statically ready` while `work-tracker-credential` shows
   `Unresolved credential`. For `wt4-doctor-credential-invalid`, confirm the
   mirror case: `work-tracker-config` shows `Statically ready` while
   `work-tracker-credential` shows `Invalid config`. In every diverging case
   the report-level verdict matches whichever check is not `ready`. Only
   `wt4-doctor-absent` and `wt4-doctor-ready` have both check pills match the
   seeded state.

Pass criteria:

- Only statuses `ready`, `not-configured`, `unreachable`, or `invalid` appear.
- Jira/Pinga checks are described as static/non-executing; Pi is local catalog
  only; GitHub/Git checks are read-only; work-tracker checks are static and
  never contact Plane/Jira/GitHub.
- `work-tracker-config` and `work-tracker-credential` classify different
  concerns (provider/config vs. credential-ref) and are not clones of each
  other: they agree only when both concerns share the same state (absent, or
  both statically ready) and diverge whenever exactly one concern is
  defective -- an invalid/incomplete config with a well-formed ref, or a
  valid config with a missing/malformed/unresolved ref. The report-level
  `work_tracker` block gives the single combined verdict. All five states —
  `absent`, `incomplete`, `invalid`, `unresolved`, `ready` — are correctly
  distinguished.
- No raw token, token preview, subprocess stdout/stderr, or environment dump is
  visible in API output, browser UI, terminal logs, or screenshots.
