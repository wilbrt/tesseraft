# Standalone Linter

The linter is a standalone product surface.

It must not depend on:

- Pi
- Jira
- GitHub
- agent-browser
- runner state
- UI state

It may be used in:

- CI
- pre-commit hooks
- Workflow Studio validation
- Pi authoring helper patch validation
- runner startup validation

## Commands

```bash
agent-workflow-lint workflow.edn
agent-workflow-lint workflow.edn --format json
agent-workflow-lint workflow.edn --strict
agent-workflow-lint workflow.edn --emit graph
agent-workflow-lint workflow.edn --emit mermaid
```
