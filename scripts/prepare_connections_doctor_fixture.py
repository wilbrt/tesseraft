#!/usr/bin/env python3
"""Seed a disposable multi-project fixture for Connections Doctor review."""

import json
from pathlib import Path


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


root = Path.cwd()
projects = root / ".tesseraft" / "projects"
workspace = root / ".agent-runs" / "manual-connections-doctor-explicit-ws"
workflow_dir = workspace / ".tesseraft" / "workflows" / "manual-doctor"
(workflow_dir).mkdir(parents=True, exist_ok=True)
(workspace / "runs").mkdir(parents=True, exist_ok=True)

(workflow_dir / "workflow.edn").write_text(
    """{:api-version \"tesseraft.workflow/v1\"
 :kind :workflow
 :metadata {:name \"manual-doctor\" :title \"Manual Doctor\"}
 :defaults {:max-rounds 1 :state-timeout \"1m\"}
 :policies {:require-timeouts true :require-max-rounds true}
 :initial :start
 :states {:start {:type :deterministic
                  :handler :noop/succeed
                  :runtime {:timeout \"10s\"}
                  :next :done}
          :done {:type :terminal :title \"Done\" :status :success}}}
""",
    encoding="utf-8",
)

write_json(
    projects / "default.json",
    {
        "project_id": "default",
        "name": "Default",
        "workspace_root": ".",
        "runs_root": ".agent-runs",
        "discovery": {"workflow-roots": [".tesseraft/workflows", "examples"]},
        "settings": {},
    },
)
write_json(
    projects / "doctor-explicit.json",
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
                "credential-ref": "env:DOCTOR_EXPLICIT_JIRA_TOKEN",
            },
        },
    },
)

print(json.dumps({"project_id": "doctor-explicit", "workspace": str(workspace)}))
