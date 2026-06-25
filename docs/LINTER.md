# Tesseraft Standalone Linter

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
tesseraft lint workflow.edn
tesseraft lint workflow.edn --format json
tesseraft lint workflow.edn --strict
tesseraft lint workflow.edn --emit graph
tesseraft lint workflow.edn --emit mermaid
```
