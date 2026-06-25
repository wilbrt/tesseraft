# Tesseraft Workflow Specification

Status: Draft  
Version: `agent.workflow/v1`

## 1. Goals

The workflow specification defines a portable, infrastructure-as-code format for declaring deterministic and agentic state machines.

A compliant implementation must be able to parse workflow definition files, validate them without side effects, render them as a directed graph, execute runs from a pinned workflow version, persist run state and node attempts, and support standalone linting in CI.

The workflow definition is the source of truth. UI state, database state, and runtime state must not silently redefine workflow behavior.

## 2. Non-goals

The spec does not mandate a programming language, UI framework, agent runtime, or EDN as the only supported syntax. EDN is the initial authoring syntax. The normalized workflow model must be representable as JSON.

## 3. Package files

A workflow package may contain:

```text
workflow.edn
prompts/*.md.tmpl
scripts/*
schemas/*.schema.json
policies.edn
```

## 4. Top-level workflow shape

```edn
{:api-version "agent.workflow/v1"
 :kind :workflow
 :metadata {:name "jira-to-pr"}
 :inputs {:ticket {:type :string :required true}}
 :defaults {:max-rounds 8 :state-timeout "30m"}
 :policies {:runtime-cannot-edit-workflow true}
 :initial :fetch-ticket
 :states {...}}
```

Required top-level fields are `:api-version`, `:kind`, `:metadata`, `:initial`, and `:states`.

## 5. Node types

Supported node types are:

- `:agent` — bounded agent session, for example Pi SDK/CLI.
- `:deterministic` — trusted built-in handler.
- `:process` — external executable using JSON stdin/stdout.
- `:timer` — resumable timer/wait state.
- `:approval` — human approval gate.
- `:router` — pure transition logic.
- `:terminal` — terminal success/failure state.

## 6. Common node fields

Every non-terminal node must have either `:next` or `:transitions`.

```edn
{:type :agent
 :title "Manual browser test"
 :inputs {}
 :outputs {}
 :runtime {}
 :transitions []
 :ui {}}
```

## 7. Agent node

```edn
:manual-test
{:type :agent
 :executor :pi-cli
 :prompt-template "prompts/manual-test.md.tmpl"
 :tools [:read :bash :write :grep :find :ls]
 :runtime {:cwd "{{inputs.repo-root}}" :timeout "45m"}
 :outputs {:status {:path "manual-review/status-{{run.round}}.json" :required true}
           :report {:path "manual-review/report-{{run.round}}.md" :required true}
           :issues {:path "manual-review/issues-{{run.round}}.json" :required false}}
 :transitions [{:when {:status "pass"} :next :code-review}
               {:when {:status "fail"} :effects [:merge-issues :inc-round] :next :execute}]}
```

Agent nodes must declare a status artifact. Runtime agent sessions must not modify workflow source files unless the node belongs to a workflow-authoring surface.

## 8. Deterministic node

```edn
:create-pr
{:type :deterministic
 :handler :github/create-pr
 :runtime {:timeout "5m" :requires-secrets [:github-token]}
 :outputs {:pr-json {:path "pr/pr.json" :required true}}
 :next :wait-for-feedback}
```

Handlers must be registered by the runner. The linter validates known handlers when a handler registry is provided.

## 9. Process node

```edn
:fetch-ticket
{:type :process
 :command ["node" "scripts/fetch-jira-ticket.js"]
 :input-mode :json-stdin
 :output-mode :json-stdout
 :outputs {:ticket-json {:path "ticket.json" :required true}}
 :next :design}
```

Process nodes are the language-neutral plugin mechanism. They receive a JSON request on stdin and return a JSON response on stdout.

## 10. Timer, approval, router, terminal

Timer nodes declare `:duration`. Approval nodes declare `:message` and transitions based on `:decision`. Router nodes only evaluate transitions and apply declared effects. Terminal nodes declare `:status :success` or `:status :failure`.

## 11. Transitions and effects

Transitions are evaluated in order.

```edn
:transitions [{:when {:status "pass"} :next :done}
              {:when {:status "fail"} :effects [:merge-issues :inc-round] :next :execute}]
```

Built-in effects are `:merge-issues`, `:clear-issues`, `:inc-round`, `:inc-feedback-cycle`, `:set-context`, `:record-pr`, and `:fail-run`.

Effects mutate run state, not workflow definition.

## 12. Artifact contracts

Outputs must be declared. Output values may be strings or maps with `:path`, `:schema`, and `:required`.

```edn
:outputs {:status {:path "code-review/status-{{run.round}}.json"
                   :schema "schemas/status.schema.json"
                   :required true}}
```

Required artifacts are validated after node execution. The linter validates output paths and declared schemas.

## 13. Standard status artifact

```json
{"status":"pass","summary":"Short summary","issues_file":null}
```

Supported statuses are `pass`, `fail`, `actions_needed`, `no_actions`, `ok`, and `error`.

## 14. Standard issues artifact

```json
[{"source":"manual-testing","severity":"major","title":"...","details":"...","acceptance_criteria":"..."}]
```

Supported severities are `blocker`, `major`, `minor`, and `nit`.

## 15. Template variables

Templates may use `{{...}}` variables. Required namespaces are `inputs.*`, `defaults.*`, `run.*`, `node.*`, `artifacts.*`, `workflow.*`, and `env.*`.

## 16. Runtime state

A run must be pinned to an immutable workflow version.

```json
{"run_id":"run_01HX","workflow_name":"jira-to-pr","workflow_version":"git:abc123","state":"manual-test","round":2,"status":"running"}
```

Existing runs must not silently switch workflow versions.

## 17. Event log

Runtime events are appended as JSONL. Required categories include `run.started`, `node.started`, `node.finished`, `transition.selected`, `artifact.written`, `effect.applied`, `approval.requested`, `approval.decided`, and `agent.event`.

## 18. Executor protocol

Agent executors receive a normalized node execution request and may stream events. They return a result with `ok`, `status`, `artifacts`, and `events`.

## 19. Process-node protocol

Process nodes receive JSON on stdin and return JSON on stdout.

Request:

```json
{"run":{},"node":{},"inputs":{},"paths":{"run_dir":"...","repo_root":"..."}}
```

Response:

```json
{"ok":true,"status":"pass","outputs":{"ticket-json":"ticket.json"}}
```

## 20. Linter requirements

A compliant linter detects malformed files, unsupported versions, missing initial state, missing terminal state, unknown transitions, unreachable states, dead ends, unknown node types, unknown handlers, unknown executors, missing prompt templates, missing process scripts, missing status outputs for agent nodes, invalid artifact paths, duplicate artifact outputs, cycles without retry/exit policy, unresolved template variables, and policy violations.

## 21. Linter result format

```json
{"ok":false,"errors":[{"code":"unknown-next-state","severity":"error","path":["states","manual-test","transitions",1,"next"],"message":"Transition points to missing state: execute-fixes"}],"warnings":[]}
```

Exit codes: `0` valid, `1` lint errors, `2` malformed input or internal failure.

## 22. UI separation

Workflow Studio edits workflow definition files. Run Console observes and controls workflow runs. Authoring Pi sessions belong to Workflow Studio. Runtime Pi sessions belong to Run Console. Runtime sessions must not modify workflow definitions. Authoring sessions must not mutate live run state.

## 23. Versioning and portability

The `:api-version` field controls compatibility. A run records the exact workflow content hash or Git commit SHA used at start time. EDN is an authoring syntax; normalized workflows must be JSON-representable.
