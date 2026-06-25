# Package Plan

## `agent-workflow-spec`

Owns the file format, parser, normalizer, template helper functions, and schema references.

## `agent-workflow-lint`

Standalone CLI/library for static workflow validation. Depends on the spec package only.

## `agent-workflow-runner`

Reference execution engine. Depends on spec + linter and loads executor/handler registries.

## `agent-workflow-pi-executor`

Executor package for Pi CLI now and Pi SDK later.

## `agent-workflow-adapter-*`

Deterministic handlers such as Jira, GitHub, git, notifications, and deployment adapters.

## `agent-workflow-ui`

Future Workflow Studio and Run Console. It must use spec/linter/runner APIs and never become the source of truth for workflow definitions.
