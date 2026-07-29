# Tesseraft Self-contained Fragments

Status: Draft — authoring, lint, and bounded agent/process/timer/deterministic/router/terminal runtime execution implemented

Version: `tesseraft.fragment/v1`

Self-contained fragments are portable **multi-node subgraph** packages with a declared boundary contract. A fragment owns its internal graph and assets; an importing workflow owns the inclusion state id, bindings, outgoing transitions, and eventual path namespace.

> **Current safety boundary:** fragment packages can be read, linted, discovered, and imported as complete lint-valid boundary inclusions. A workflow containing `{:type :fragment}` runs when the fragment's reachable internal states are limited to `:agent`, `:process`, `:timer`, `:deterministic`, `:router`, and `:terminal`: the runner pins the resolved package, executes the internal subgraph in an isolated nested context through the exact same executor/handler/transition machinery as a top-level workflow (package-relative prompt/script assets, inherited runner mock mode), and maps the reached terminal outcome onto the parent `:fragment/outcome` transition. On success the reached exit entry's declared `:produces` outputs are materialized from the nested run dir into the parent run dir at the inclusion's `:prefix`. A fragment whose reachable internal graph reaches an `:approval` node still fails durably and cleanly with `fragment_unsupported_node` before any internal state runs — lint accepts approval nodes structurally, but the runtime does not execute them yet (no control plane inside a fragment). A nested `:fragment` state is rejected earlier and separately: package lint treats any `:fragment` state as a structural error, so an inclusion whose package contains one fails durably with `fragment_unresolved` at resolution, before the unsupported-node scan ever runs. Do not use approval or nested-fragment nodes inside a fragment in production workflows yet.

This document distinguishes the implemented P1.4 surface from the target executable contract. The ordered implementation prompts are in [FRAGMENT_IMPLEMENTATION_PROMPTS.md](FRAGMENT_IMPLEMENTATION_PROMPTS.md).

## Current implementation status

| Capability | State |
|---|---|
| EDN fragment package parsing | Implemented |
| Package and internal-subgraph lint | Implemented |
| Inclusion input/outcome diagnostics | Implemented |
| Inclusion scope/version/binding/prefix contract and inspectable effective data | Implemented for workflow lint |
| Asset validation and collision-safe copying | Implemented |
| Project/global/example discovery helpers | Implemented |
| `tesseraft fragment lint` | Implemented |
| `tesseraft fragment import` transactional complete inclusion | Implemented |
| Equivalent JSON package input | Implemented for explicit lint/import package paths via a fragment-only normalization boundary; package discovery currently uses `fragment.edn` |
| JSON-compatible normalized projection | Implemented (`portable-fragment-package-data`) |
| JSON Schema enforcement | Not wired into the linter; descriptive contract only |
| Required outcome/exit enforcement when omitted | Implemented |
| Parameter, version, and prefix semantics | Implemented for static workflow lint; version/inputs/parameters are re-resolved and bound into the nested run at execution |
| Boundary resource projection into workflow lint | Implemented for static workflow lint; runtime exit-output materialization now projects the reached exit entry's outputs at the same prefixed paths |
| Runtime fragment execution | Implemented for reachable internal graphs limited to `:agent`/`:process`/`:timer`/`:deterministic`/`:router`/`:terminal`; pin, isolated nested context, package-relative assets, fragment-local rounds/attempts, terminal-outcome mapping, durable nested state/events |
| Runtime exit-output materialization | Implemented: reached exit entry's `:produces` paths are copied from the nested run dir to `<parent-run>/<prefix>/<path>` in `finish!`, validated as safe relative paths (blocked by lint, and independently refused at runtime with `fragment_exit_output_invalid_path`), validated against `:interface :outputs :required`, and guarded against cross-inclusion collisions — including a pre-existing parent-owned destination with no recorded fragment ownership — by a per-run `fragments/exit-index.json` ownership index |
| Runtime execution of approval internal nodes | Not implemented; rejected durably as `fragment_unsupported_node` before any internal execution (no control plane inside a fragment) |
| Runtime execution of nested `:fragment` internal nodes | Not implemented; package lint rejects any nested `:fragment` state structurally, so the inclusion fails durably as `fragment_unresolved` at resolution |
| Public fragment control-plane API / Studio catalog | Not implemented |
| Fragment gallery | Deferred (roadmap P1.5) |
| Fragment export/extraction | Deferred (roadmap P4.3) |

P1.4 is complete in its deliberately bounded sense: spec/linter/docs, discovery helpers, one fixture, and `fragment lint|import`. FI6 added a bounded runtime for deterministic/router/terminal internal graphs; FI7 extended it to agent/process/timer internal nodes, prefixed exit-artifact materialization, and mock mode. Internal approvals, nested fragments, nested resume/recovery, and the public API/UI/gallery surface remain future work (FI8+).

## Implemented package shape

The operational package format accepts EDN and equivalent JSON when a package file is passed explicitly to lint/import. Fragment packages are normalized once, immediately after generic file parsing, before those consumers inspect them:

```edn
{:api-version "tesseraft.fragment/v1"
 :kind :fragment
 :metadata {:name "test-fix-loop"
            :title "Test-fix loop"
            :description "Lint, run tests, fix on failure, bounded rounds."
            :version "0.1.0"
            :authors ["Example Author"]
            :tags ["test" "loop"]}
 :interface {:inputs {:repo-root {:type :string :required true}
                      :test-cmd {:type :string :required true}}
             :parameters {:max-rounds {:type :integer :default 3}
                          :base-branch {:type :string :default "main"}}
             :outputs {:status {:schema "schemas/status.schema.json" :required true}
                       :issues {:path "issues/issues.json" :required false}}
             :outcomes #{:pass :fail}}
 :requirements {:executors [:pi-cli]
                :handlers [:noop/succeed]
                :tools [:read :bash :write :grep]
                :secrets []
                :template-vars ["inputs.repo-root" "inputs.test-cmd"
                                "parameters.max-rounds" "run.round"]
                :resources {:requires [{:kind :input :name "repo-root" :mode :reusable}
                                       {:kind :input :name "test-cmd" :mode :reusable}
                                       {:kind :capability :name "pi-cli"}]
                            :produces [{:kind :artifact :name "status"
                                        :path "status/status.json"}
                                       {:kind :issue-file :name "issues"
                                        :path "issues/issues.json"}]}}
 :assets {:prompts ["prompts/fix.md.tmpl"]
          :schemas ["schemas/status.schema.json"]}
 :fragment {:initial :lint
            :defaults {:max-rounds 3 :state-timeout "10m"}
            :entry {:inputs [:repo-root :test-cmd]
                    :parameters [:max-rounds :base-branch]}
            :exit [{:on :pass :produces {:status "status/status.json"}}
                   {:on :fail :produces {:status "status/status.json"
                                         :issues "issues/issues.json"}}]
            :states {:lint {...}
                     :test {...}
                     :fix {...}
                     :done {:type :terminal :status :success :outcome :pass}
                     :failed {:type :terminal :status :failure :outcome :fail}}}}
```

Required top-level fields currently enforced are `:api-version`, `:kind`, `:metadata`, `:interface`, and `:fragment`. The internal fragment requires `:initial` and `:states`, and the FI1 outcome/exit/terminal/nesting contract is enforced by lint.

`schemas/fragment-package.schema.json` describes the JSON-shaped package contract, but it is not currently loaded by fragment lint. Lint uses the parser boundary instead: JSON strings/arrays in semantic positions are canonicalized to the EDN-style internal values used by existing checks, while arbitrary payload strings are preserved.

## Normalization and portable projection

`read-fragment-package` is the single fragment-package normalization boundary. It canonicalizes semantic values that lint treats as identifiers or enums: package kind, fragment state ids and initial/transition targets, node types, handlers, executors, tools, transition effects, interface outcomes, terminal outcomes, exit outcomes, and fragment entry names. Workflow and node package readers are unchanged.

For consumers that need JSON data, `portable-fragment-package-data` returns a deterministic projection of the normalized package with source metadata removed, keywords encoded as namespace-preserving strings such as `noop/succeed`, sets emitted as sorted vectors, and maps recursively converted to string keys. This projection is intended for inspection/serialization, not runtime fragment execution.

## Boundary contract

### Inputs

`:interface :inputs` describes values supplied by an importing workflow. Inclusion lint normalizes declared and bound names to keyword identity, rejects normalization collisions, rejects unknown bindings, requires every input unless `:required false`, treats `nil` as missing for required inputs, and validates known scalar literals without coercion. Input declaration `:default` values do not satisfy required inputs and are not synthesized into effective inclusion inputs; successful input data reflects authored bindings only.

Supported scalar types are `:string`, `:integer`, `:number`, and `:boolean`. Unsupported declared types are lint errors. Templated strings remain strings; lint does not evaluate templates or coerce string values into numbers/booleans. Authored bindings are exposed as derived lint data only because fragment execution is absent.

### Parameters

`:interface :parameters` describes configurable fragment behavior and defaults. Package lint synthesizes inputs and parameters into the internal template-variable environment so internal prompt/template checks can resolve them.

Inclusion lint validates parameter names and scalar values with the same normalization/type rules as inputs. Parameters are optional by default; `:required true` requires either an authored non-`nil` value or a declared default. Effective parameters merge declared defaults before authored overrides and are exposed in `:fragment-inclusions`.

### Outputs and outcomes

`:interface :outputs` describes artifacts exposed by fragment exits. `:interface :outcomes` is required to be a non-empty set of keyword outcomes such as `#{:pass :fail}`. `:fragment :exit` is required to be non-empty and maps each outcome to its exposed outputs.

Implemented package-lint and JSON Schema checks include:

- interface outcomes must be present and non-empty;
- fragment exits must be present and non-empty;
- exit outcomes must be declared by the interface;
- declared outcomes must have exit entries;
- every exit must produce each required interface output;
- inclusion transitions may only reference declared outcomes;
- uncovered outcomes produce a warning;
- v1 fragment packages may not contain nested `:fragment` states.

Reachable internal terminal states must keep workflow-style terminal `:status` and explicitly select exactly one declared fragment outcome with `:outcome`. Every declared outcome must be produced by at least one reachable terminal state; multiple reachable terminals may select the same declared outcome only when every declared outcome remains producible. For example, a terminal may use `{:type :terminal :status :success :outcome :pass}` so workflow terminal status remains distinct from the fragment outcome contract.

### Requirements and resources

`:requirements` records executors, handlers, tools, secrets, template variables, and boundary resources. Package lint validates resource declaration shape. Internal `:fragment :resources` and node `:resources` participate in the internal-subgraph proof.

For a valid workflow inclusion, package boundary `:requirements :resources` is projected into static workflow resource analysis as derived inclusion resources. Exact `{{inputs.x}}` / `{{defaults.x}}` input bindings alias the importer's ambient resource identity; literal scalar bindings satisfy the fragment boundary without inventing an external prerequisite. Safe inclusion prefixes are prepended to boundary resource paths. Produced boundary resources are advertised only when the corresponding output is present on every declared exit with the same path after prefixing.

## Internal subgraph lint

`lint-fragment-package` constructs a workflow-like value from the internal graph and applies the workflow primitives once at package-validation time:

- initial and terminal checks;
- node type and node contract checks;
- transition and reachability checks;
- output/path/schema checks;
- duplicate output checks;
- resource shape and flow checks;
- bounded-cycle checks;
- template-variable checks;
- prompt, script, schema, and declared-asset checks.

When a workflow includes the same fragment package, internal results are cached per package path and surfaced at most once as `fragment-internal-lint-failed`. Import sites do not independently duplicate all internal diagnostics.

Nested `{:type :fragment}` nodes inside a fragment are not given meaningful lint or runtime semantics today. They should be rejected until an explicit nesting model exists.

See [LINTER.md](LINTER.md) for current diagnostics.

## Inclusion model

A lintable inclusion currently looks like:

```edn
:run-tests
{:type :fragment
 :fragment "test-fix-loop"
 :scope :project
 :inputs {:repo-root "{{inputs.repo-root}}"
          :test-cmd "bb test"}
 :parameters {:max-rounds 3
              :base-branch "{{inputs.base-branch}}"}
 :transitions [{:when {:fragment/outcome "pass"} :next :pr}
               {:when {:fragment/outcome "fail"} :next :abort}]}
```

Implemented inclusion semantics:

- `:fragment` must be a single safe package name (not a path, drive-qualified form, `.` or `..`) and the resolved package `:metadata :name` must match it exactly;
- `:scope` may be a keyword or string and canonicalizes to `:project`, `:global`, or `:examples` (`:example`/`:configured` are examples aliases);
- omitted scope uses project > global > examples precedence; explicit scope searches only that scope and never falls back;
- `:version`, when present, must be a non-blank string exactly equal to `:metadata :version` of the resolved package;
- `:prefix`, when present, must be a non-blank portable safe relative prefix: no absolute, drive/UNC, `.`/`..`, backslash, or parent traversal forms;
- input/parameter declaration and binding containers must be maps; declaration entries must be maps; required and unknown bindings, parameter defaults, collisions, supported scalar declarations, and literal scalar values are checked without coercion;
- transition outcomes are checked against the interface;
- broken package lint is surfaced as one aggregate inclusion error.

A successful workflow lint result includes derived `:fragment-inclusions` keyed by inclusion state id. Each entry contains `:package-path`, canonical `:scope`, resolved `:version`, normalized/omitted `:prefix`, authored effective `:inputs`, defaults-merged effective `:parameters`, and effective boundary `:resources` (`:requires`, `:consumes`, and conservative all-exit `:produces`). This is inspection data only; lint does not mutate the workflow, copy resources, write prefixed artifacts, or execute fragments — see [Runtime behavior](#runtime-behavior) for what execution actually does with `:prefix` and exit outputs. Internal fragment-state resources remain private and are not projected.

The importing workflow ultimately needs to own the state id, scope/version selection, explicit bindings, path prefix, outgoing outcome transitions, and collision handling. Those target semantics are not all implemented in v1 today.

## Discovery and control-plane state

Fragment package discovery uses the same filesystem scope convention as workflows and nodes, but currently resolves only `fragment.edn` package files:

- `examples/fragments/<name>/fragment.edn`
- `~/.tesseraft/fragments/<name>/fragment.edn` (`TESSERAFT_HOME` is honored)
- `.tesseraft/fragments/<name>/fragment.edn`

Direct-path lint/import can read an equivalent `fragment.json`, but project/global/example discovery and workflow inclusion resolution do not discover `fragment.json` packages today. Generic control-plane discovery and resolution helpers exist for `fragment.edn`, including precedence/conflict handling. There are no public fragment list/detail/graph routes and no Studio catalog surface yet.

## Local CLI

Validate a package:

```bash
./bin/tesseraft fragment lint path/to/fragment.edn
./bin/tesseraft fragment lint path/to/fragment.edn --format json --strict
```

Import a package as a complete lint-valid inclusion:

```bash
./bin/tesseraft fragment import path/to/fragment.edn workflow.edn \
  --as run-tests \
  --input 'repo-root="{{inputs.repo-root}}"' \
  --input 'test-cmd="{{inputs.test-cmd}}"' \
  --parameter max-rounds=3 \
  --parameter 'base-branch="main"' \
  --outcome pass=done --outcome fail=abort \
  --version 0.1.0 --scope project --prefix imported/test-fix-loop
```

`--input`, `--parameter`, and `--outcome` are repeatable `name=EDN` / `outcome=state` pairs. Values are parsed as single EDN scalars without coercion. `--next state` is accepted only as a fallback for declared outcomes not already routed with `--outcome`; import always writes explicit `:transitions`, never an authored `:next`.

Import currently:

1. strict-lints the package;
2. validates required bindings, parameter values, version/scope/prefix, declared outcome coverage, and all target states in memory;
3. refuses unsafe, missing, conflicting, or workflow-file-colliding assets before mutation;
4. writes a complete `:fragment` node preserving existing authored workflow fields;
5. strict-lints the candidate workflow in memory and refuses only diagnostics the import itself introduces, so a pre-existing unrelated warning elsewhere in the workflow does not block the import;
6. stages new assets and the rendered workflow, reuses byte-identical assets, and rolls back handled failures so the workflow and assets remain unchanged;
7. prints the state id plus concise input, parameter, and outcome-route summaries.

Import is not runtime composition.

`fragment export` is explicitly deferred to P4.3 and exits without extracting anything.

## Runtime behavior

Stepping a `{:type :fragment}` node now:

1. re-resolves and re-lints the inclusion against the live package on disk (the pin check happens per execution, not once at parent lint time), failing durably with `fragment_unresolved` if the package is missing or no longer valid — package lint treats any nested `:fragment` state as a structural error, so a package containing one is rejected here;
2. rejects a reachable internal node type this runtime cannot execute (`:approval`) with `fragment_unsupported_node`, before any internal state runs;
3. renders bound inputs/effective parameters against the parent context and pins package identity, scope, version, and content hash into a durable nested `pin.json`, alongside a parent `fragment.started` event;
4. runs the internal `:agent`/`:process`/`:timer`/`:deterministic`/`:router`/`:terminal` subgraph to completion in an isolated nested run directory (`fragments/<state>/<attempt>` under the parent run) via the exact same executor/handler/transition machinery as top-level workflows, honoring the package's own (or an overriding effective parameter's) `:max-rounds`. Prompt, script, and schema assets resolve package-relative (the nested workflow-like view carries the pinned package's `:__dir`/`:__file`), and the parent's runner mock mode (`--executor mock`) is inherited, so a mock dry-run renders package templates and writes placeholder artifacts into the nested run dir with no credentials or network access;
5. maps the reached terminal's declared outcome onto the parent's `:fragment/outcome` transition, or fails durably and classifiably (`fragment_max_rounds`, `fragment_internal_failure`, `fragment_outcome_unrouted`) if the nested run does not reach a routed terminal;
6. on a routed success, materializes the reached exit entry's declared `:produces` outputs: each nested-run-relative path is copied to `<parent-run>/<prefix>/<path>` (a blank `:prefix` projects onto the identical relative path, matching the FI4 lint prefix projection exactly — see [Boundary contract](#boundary-contract)). Every `:produces` value must be a safe relative path — `fragment-interface-checks` blocks any that is not at package-lint time, and `finish!` independently refuses an unsafe value with `fragment_exit_output_invalid_path` before reading or writing anything, so a package that predates the lint rule still cannot escape the nested or parent run dir. A key required by `:interface :outputs` whose file the nested run never wrote raises `fragment_exit_output_missing` before anything is copied. A destination path already owned by a different parent inclusion state, or one that already exists in the parent run dir with no recorded fragment ownership at all — both tracked against a per-run `fragments/exit-index.json` ownership index — raise `fragment_exit_output_conflict` before anything is copied, so two inclusions of the same fragment (or two differently-named inclusions colliding on the same blank-prefix path, or a blank-prefix inclusion colliding with a parent-owned artifact) can never silently overwrite one another; the same inclusion state re-materializing on its own retry is not a conflict;
7. appends a parent `fragment.finished` event carrying the materialized `:exit_outputs` map (also present on the `node.finished` result) and leaves the nested `state.edn`/`events.jsonl`/`pin.json` inspectable after the run, including after a process reload.

A fragment node is atomic within FI6/FI7: the whole nested run executes inside a single parent step, so interruption mid-fragment surfaces as the existing parent orphan failure rather than nested resume (nested resume is FI8).

Not yet implemented:

- executing `:approval` internal nodes (rejected as `fragment_unsupported_node`), or nested fragments (rejected earlier, as `fragment_unresolved`, by package lint);
- template-visibility of materialized exit outputs to parent nodes (FI8/FI10);
- nested pause/resume, approvals, cancellation, and orphan recovery (FI8);
- Studio/public API fragment execution surfaces.

## Fixture and tests

The single fixture is:

```text
examples/fragments/test-fix-loop/
  fragment.edn
  prompts/fix.md.tmpl
  schemas/status.schema.json
```

It proves package lint and import scaffolding. It does **not** prove runtime behavior; its deterministic `lint` and `test` nodes use `:noop/succeed`, and the package is never executed as a fragment.

Runtime behavior is proved by fixtures under `test/fixtures/valid/fragment-runtime/`, split across the FI6 and FI7 focused test files:

```text
test/fixtures/valid/fragment-runtime/
  runtime-pass/fragment.edn                    ; single deterministic state, terminal outcome :pass
  runtime-fail/fragment.edn                    ; single deterministic state, terminal outcome :fail
  runtime-rounds/fragment.edn                  ; router self-loop that exhausts its own :max-rounds
  runtime-timer/fragment.edn                   ; a :timer internal state that actually sleeps and routes
  runtime-unrouted/fragment.edn                ; a deterministic state whose :transitions never match its handler's result
  runtime-bound/fragment.edn                   ; router self-loop with a required :interface input and a :max-rounds parameter default
  runtime-internal-failure/fragment.edn        ; a deterministic state with a required output its handler never writes
  runtime-approval/fragment.edn                ; an :approval internal state (lint-valid, runtime-unsupported)
  runtime-process/fragment.edn                 ; a :process state running a package-relative script
  runtime-mock-agent/fragment.edn              ; an :agent state with a package prompt template and required :status output
  runtime-exit-outputs/fragment.edn            ; a :process state whose required output is projected through :fragment :exit
  runtime-exit-outputs-missing/fragment.edn    ; an exit entry that declares a required output no internal state ever writes
  runtime-retry-loop/fragment.edn              ; a :process state that fails until its own final :max-rounds, then passes
```

`test/fragment_runtime_execution.test.py` (FI6) stages `runtime-pass`, `runtime-fail`, `runtime-rounds`, `runtime-unrouted`, `runtime-bound`, `runtime-internal-failure`, and `runtime-approval` into a temp project's `.tesseraft/fragments/<name>/`, wraps each in a small parent workflow, and drives `./bin/tesseraft run start|resume|inspect|cancel` and `./bin/tesseraft control-plane` as separate processes. It asserts: the parent routes on the declared pass/fail outcome; a fragment step is atomic (`resume --max-steps 1` completes the whole nested run, inspectable via a fresh `inspect` call and via raw `state.edn`/`events.jsonl`/`pin.json` reads) while the parent keeps stepping afterward; a package deleted after `start` fails durably with `fragment_unresolved` and creates no nested run directory; the approval fixture fails durably with `fragment_unsupported_node` before any internal `node.started`; the rounds fixture fails durably with `fragment_max_rounds` without advancing the parent's own round; the unrouted fixture — whose internal node finishes but matches no transition, a failure raised by `choose-transition` outside `execute-node!`'s own try/catch — propagates its original cause (`"No transition matched result"`) into the parent's `node.failed` result rather than being reported as fragment step-budget exhaustion, while the nested run itself is left durably `"running"` with no internal `node.failed`; a parent with no transition covering the reached outcome at all lets the nested run execute to its own `"done"` in full before `finish!` fails durably with `fragment_outcome_unrouted` naming the reached outcome — `finish!` decides routability with the same `spec/match-transition?` predicate `choose-transition` uses to pick the transition, over a result the one `finish!` returns only extends (`:exit_outputs` is added afterward), and `match-transition?` reads only the keys a transition's `:when` names, so the two can never disagree; the internal-failure fixture's own `node.failed` (a required output its handler never writes) durably fails the nested run and surfaces as `fragment_internal_failure` at the parent, distinct from `fragment_max_rounds`; the bound fixture's parent-rendered input (not the raw `{{inputs.echo}}` template text) and parameter override (not the package's own `:max-rounds` default) both reach the nested run's durable `pin.json`/`events.jsonl` evidence; a process carrying a fragment-internal-run-dir `AGENT_RUN_DIR` marker is still reaped by the parent's own `run cancel`; and a run whose *run id* is literally `fragments` remains a single resolvable entry in the control plane's run inventory rather than being mistaken for a nested `fragments/<state>/<attempt>` run dir.

`test/fragment_runtime_nodes.test.py` (FI7) stages `runtime-timer`, `runtime-process`, `runtime-mock-agent`, `runtime-exit-outputs`, `runtime-exit-outputs-missing`, and `runtime-retry-loop` with `shutil.copytree` (preserving the script executable bit) and asserts: the timer fixture actually sleeps and routes on its declared outcome; the process fixture runs its script from the fragment package dir (not the workflow dir) and writes its required output into the nested run dir; the mock-agent fixture, started with `--executor mock`, renders the package-relative prompt template into the nested run dir and writes a placeholder status artifact with no credentials; the exit-outputs fixture materializes its required output at the inclusion's declared `:prefix`, recording ownership in `fragments/exit-index.json`; two inclusions of that same fixture at two distinct, non-colliding prefixes both materialize and stay independently readable at their own prefixed path, each recorded under its own key in `fragments/exit-index.json`; two inclusions of that same fixture with no distinct prefixes fail the second one durably with `fragment_exit_output_conflict` while leaving the first inclusion's projected artifact untouched; a blank-prefix inclusion refuses to overwrite a pre-existing, unowned parent-level artifact at its exit-output destination, also with `fragment_exit_output_conflict` (a null `owner_state`); a parent that loops back into the very same inclusion state re-materializes its exit output a second time without conflict, since a state re-entering on its own retry owns the destination it already owns; a `:produces` value that fails `spec/safe-relative-path?` is refused by `materialize-exit-outputs!` with `fragment_exit_output_invalid_path` before anything is read or copied, proven by calling the runtime function directly so the refusal holds independent of the matching `fragment-exit-invalid-produces-path` package-lint rule; the exit-outputs-missing fixture completes its nested run but fails the parent durably with `fragment_exit_output_missing` because the declared exit path was never written, and projects nothing; and the retry-loop fixture's internal round count reaches exactly its own `:max-rounds` before routing, while the parent's own round stays unchanged. `scripts/test.sh` strict-lints all thirteen valid fixtures and checks the `fragment-exit-unsafe-produces` invalid fixture under `--strict` and normal lint.

Focused tests in `scripts/test.sh` cover valid lint, strict lint, malformed interfaces/exits/assets, internal graph checks, inclusion input/outcome diagnostics, and authoring import. The import assertion checks that a boundary node was written, not that the resulting workflow is complete or runnable.

## Target contract and delivery order

The intended end state remains a portable, executable subgraph boundary, but implementation should proceed in dependency order:

1. enforce complete outcome/exit and terminal mapping invariants;
2. align EDN, normalized data, and JSON Schema behavior;
3. enforce inclusion inputs, parameters, versions, prefixes, and scope;
4. project boundary resources into workflow lint;
5. make CLI import transactional and capable of producing an explicitly complete integration;
6. add minimal deterministic runtime execution;
7. add full ordinary node, output, loop, and mock behavior;
8. add resumability, approvals, recovery, and nested observability;
9. expose public discovery/inspection surfaces;
10. seed runnable gallery fragments;
11. add Studio composition and later extraction/export.

Each increment and its ready-to-run Canon TDD prompt is specified in [FRAGMENT_IMPLEMENTATION_PROMPTS.md](FRAGMENT_IMPLEMENTATION_PROMPTS.md).
