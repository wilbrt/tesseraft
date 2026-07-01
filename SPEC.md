# Tesseraft Workflow Specification

Status: Draft  
Version: `tesseraft.workflow/v1`

## 1. Goals

The workflow specification defines a portable, infrastructure-as-code format for declaring deterministic and agentic state machines.

Tesseraft workflows are controlled resource transformations. Inputs, artifacts, branches/worktrees, schemas, prompt templates, approvals, policies, and capabilities are resources with explicit semantics: some are reusable, some are produced, some are consumed once, some are unavailable until produced, and some are capability-like permissions such as tools, handlers, executors, or secrets. Nodes are resource transformation rules: they require resources, may consume resources, and produce resources. The linter is a practical static proof checker for possible executions; runtime events, artifacts, attempts, and validated transitions are the proof trace.

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
{:api-version "tesseraft.workflow/v1"
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

Nodes may declare optional resource metadata. This metadata is lintable proof evidence only; it does not replace `:inputs`, `:outputs`, `:tools`, `:runtime`, handlers, or transitions.

```edn
:resources {:requires [{:kind :input :name "prompt" :mode :reusable}
                       {:kind :capability :name "pi"}]
            :consumes [{:kind :issue-file :name "retry-issues" :path "execution/issues-{{run.round}}.json"}]
            :produces [{:kind :design-doc :name "design" :path "design/design.md"}]}
```

Allowed groups are `:requires`, `:consumes`, and `:produces`. Each group value is a vector of maps. Each resource map must include `:kind` and `:name`; optional fields are `:path`, `:mode`, `:description`, `:schema`, `:source`, `:tool`, `:secret`, `:handler`, and `:executor`. Values must remain JSON-normalizable. Suggested kinds include inputs, artifacts, worktrees, branches, prompts, design docs, manual-testing specs, web-service/test-server resources, issue files, validation reports, review evidence, PR metadata/URLs, logs/artifacts, secrets, capabilities, tools, and policy/approval gates. Suggested modes are `:reusable`, `:one-shot`, `:read`, `:write`, and `:read-write`.

A resource identity is `[kind name path]` when `:path` is present, otherwise `[kind name]`, after normalizing keyword and string values. Workflow `:inputs` and `:defaults` may satisfy ambient/reusable resources only when the resource identity matches a declared top-level binding key, an explicit binding alias such as `:name`/`:resource-name`, or a documented compatibility alias (for example, `{:kind :input :name "prompt"}` requires `:inputs {:prompt ...}`). Run-state resources and capability-like resources (`:capability`, `:tool`, `:handler`, `:executor`, `:secret`, policy-style resources) may be ambient/reusable by kind. Produced resources such as artifacts, services, worktrees, branches, reports, and specs are unavailable until a reachable predecessor produces the same identity. `:requires` declares non-consuming access. `:consumes` declares access that may be one-shot; service endpoint consumes, including `:web-service` and `:test-server`, default to one-shot unless marked `:mode :read` or `:mode :reusable`. One-shot identities may not be consumed more than once along any control-flow path.

A `:manual-testing-spec` artifact records the design-produced browser testing contract: whether testing is required or skipped, the skip gate/rationale if any, tested surfaces, expected evidence, setup requirements, stale-server hazards, responsive/console checks, acceptance criteria, and provenance checks. A `:web-service` or `:test-server` resource is a produced service endpoint, not ambient localhost state. Its JSON artifact should include `kind`, `url`, `host`, `port`, `pid` when available, `cwd`/`worktree_root`, `command`, `started_at`, and lifecycle cleanup notes.

## 7. Agent node

```edn
:manual-test
{:type :agent
 :executor :pi-cli
 :provider "openai"
 :model "gpt-4o-mini"
 :prompt-template "prompts/manual-test.md.tmpl"
 :tools [:read :bash :write :grep :find :ls]
 :runtime {:cwd "{{inputs.repo-root}}" :timeout "45m"}
 :outputs {:status {:path "manual-review/status-{{run.round}}.json" :required true}
           :report {:path "manual-review/report-{{run.round}}.md" :required true}
           :issues {:path "manual-review/issues-{{run.round}}.json" :required false}}
 :transitions [{:when {:status "pass"} :next :code-review}
               {:when {:status "fail"} :effects [:merge-issues :inc-round] :next :execute}]}
```

Agent nodes must declare a status artifact. Agent nodes may optionally declare `:provider` and/or `:model` as non-blank strings; the Pi CLI executor passes them as `--provider` and `--model` for that node only, and omission preserves executor defaults. Runtime agent sessions must not modify workflow source files unless the node belongs to a workflow-authoring surface.

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

Built-in git handlers include `:git/ensure-branch` and `:git/ensure-worktree`. Worktree mode creates or reuses a deterministic Git worktree for the run, writes a worktree path artifact (default `worktree/path.txt`), and exposes the selected checkout as `{{run.worktree-dir}}` for downstream agent and deterministic nodes. Worktree cleanup is explicit/manual; runners must not remove worktrees automatically.

The built-in `:web/start-test-server` handler starts a local worktree-rooted web UI on an OS-assigned port, waits for readiness, and writes a web-service JSON artifact for downstream manual testing. Consumers must use the produced URL and verify the artifact's `cwd`/`worktree_root` provenance rather than assuming a fixed localhost port.

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

Supported declared workflow outcomes include `pass`, `fail`, `actions_needed`, `no_actions`, and `ok`. These are workflow semantics: for example, `status: fail` may intentionally select a retry or remediation transition and must not be treated as a runtime crash.

`status: error` is reserved for normalized runtime/external failure evidence in the reference runner. External failures include missing dependencies or credentials, subprocess crashes or nonzero exits, malformed process output, timeouts, sandbox/network/environment failures, unknown handlers/executors, and required artifacts not being produced. External failures append durable `node.failed` evidence, mark the node attempt and run failed, preserve diagnostics such as logs/prompts/exit codes, and require explicit recovery, resume, or retry semantics rather than normal transition selection.

## 14. Standard issues artifact

```json
[{"source":"manual-testing","severity":"major","title":"...","details":"...","acceptance_criteria":"..."}]
```

Supported severities are `blocker`, `major`, `minor`, and `nit`.

## 15. Template variables

Templates may use `{{...}}` variables. Required namespaces are `inputs.*`, `defaults.*`, `run.*`, `node.*`, `artifacts.*`, `workflow.*`, and `env.*`. Common run variables include `{{run.id}}`, `{{run.dir}}`, `{{run.state}}`, `{{run.round}}`, and, after `:git/ensure-worktree`, `{{run.worktree-dir}}`.

## 16. Runtime state

A run must be pinned to an immutable workflow version.

```json
{"run_id":"run_01HX","workflow_name":"jira-to-pr","workflow_version":"git:abc123","state":"manual-test","round":2,"status":"running"}
```

Existing runs must not silently switch workflow versions.

## 17. Event log

Runtime events are appended as JSONL. Required categories include `run.started`, `node.started`, `node.finished`, `node.failed`, `transition.selected`, `artifact.written`, `effect.applied`, `approval.requested`, `approval.decided`, and `agent.event`.

The event log is part of the proof trace. After `node.started`, a runner must append a closing event (`node.finished` for declared outcomes or `node.failed` for runtime/external failures) before marking the run failed or advancing state.

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

A zero exit with valid JSON and `ok` not false is a protocol-level response whose `status` may drive declared transitions. A nonzero exit, malformed JSON, `ok:false`, or `status:"error"` is treated by the reference runner as an external/runtime failure and does not enter transition selection.

## 20. Linter requirements

A compliant linter detects malformed files, unsupported versions, missing initial state, missing terminal state, unknown transitions, unreachable states, dead ends, unknown node types, unknown handlers, unknown executors, missing prompt templates, missing process scripts, missing status outputs for agent nodes, invalid artifact paths, duplicate artifact outputs, cycles without retry/exit policy, unresolved template variables, policy violations, and resource declaration shape errors.

For `:resources`, the linter validates that declarations are maps, known groups are vectors, entries are maps with `:kind` and `:name`, fields are from the documented set, paths are safe relative paths, and duplicate `[group kind name path]` declarations are reported. Unknown groups and unknown modes are warnings. It also performs conservative control-flow proof checks: a produced resource required or one-shot-consumed by a node must be available on every incoming path, branch joins intersect availability, consumed one-shot identities are unioned across incoming paths, and cyclic flows are bounded with a conservative warning if they cannot converge. Missing availability is reported as `resource-missing-producer`; repeated one-shot consumption is reported as `resource-double-consume`. This is a practical proof check, not a requirement for a full theorem prover.

## 21. Linter result format

```json
{"ok":false,"errors":[{"code":"unknown-next-state","severity":"error","path":["states","manual-test","transitions",1,"next"],"message":"Transition points to missing state: execute-fixes"}],"warnings":[]}
```

Exit codes: `0` valid, `1` lint errors, `2` malformed input or internal failure.

## 22. UI separation

Workflow Studio edits workflow definition files. Run Console observes and controls workflow runs. Authoring Pi sessions belong to Workflow Studio. Runtime Pi sessions belong to Run Console. Runtime sessions must not modify workflow definitions. Authoring sessions must not mutate live run state.

## 23. Versioning and portability

The `:api-version` field controls compatibility. A run records the exact workflow content hash or Git commit SHA used at start time. EDN is an authoring syntax; normalized workflows must be JSON-representable.
