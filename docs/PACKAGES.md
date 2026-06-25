# Tesseraft Package Plan

## `tesseraft-spec`

Owns the file format, parser, normalizer, template helper functions, and schema references.

## `tesseraft-lint`

Standalone CLI/library for static workflow validation. Depends on the spec package only.

## `tesseraft-runner`

Reference execution engine. Depends on spec + linter and loads executor/handler registries.

## `tesseraft-pi-executor`

Executor package for Pi CLI now and Pi SDK later.

## `tesseraft-adapter-*`

Deterministic handlers such as Jira, GitHub, git, notifications, and deployment adapters.

## `tesseraft-ui`

Future Workflow Studio and Run Console. It must use spec/linter/runner APIs and never become the source of truth for workflow definitions.
