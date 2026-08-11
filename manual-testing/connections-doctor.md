# Connections Doctor judgment check

Automated tests own doctor classification and redaction. This procedure is only for judging the Settings presentation and remediation clarity.

From the repository root:

```sh
set -euo pipefail
export TESSERAFT_HOME="$PWD/.agent-runs/manual-doctor-home"
PROJECT_ROOT="$PWD/.agent-runs/manual-doctor-project"
mkdir -p "$PROJECT_ROOT/.tesseraft/workflows/manual-doctor"

cat > "$PROJECT_ROOT/.tesseraft/project.json" <<'JSON'
{
  "version": 2,
  "project_id": "manual-doctor",
  "name": "Manual Doctor",
  "runs_root": "runs",
  "discovery": {"workflow_roots": [".tesseraft/workflows"]},
  "connections": {
    "code-host": {"provider": "github", "auth-mode": "ambient"},
    "work-tracker": {
      "provider": "github-issues",
      "credential-ref": "env:MANUAL_DOCTOR_UNSET_TOKEN",
      "config": {"repository": "owner/repository"}
    }
  }
}
JSON

./bin/tesseraft control-plane project register "$PROJECT_ROOT"
npm run build:web
node web/server.js --host 127.0.0.1 --port 5050
```

Open `http://127.0.0.1:5050`, select **Manual Doctor**, and open **Settings**.

Pass when:

- project configuration, code host, work tracker, preferences, Git identity, and Doctor are visibly separate concerns;
- the work-tracker credential is shown as unresolved without displaying an environment value;
- each non-ready check provides concise remediation;
- the report remains usable at narrow viewport widths and keyboard focus is visible;
- no token preview, subprocess output, or environment dump appears.

The API classification is independently covered by `test/work-tracker-settings-doctor.test.js` and `test/web-server.test.js`. Remove `.agent-runs/manual-doctor-*` after the review.
