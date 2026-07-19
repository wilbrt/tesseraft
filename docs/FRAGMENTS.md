# Tesseraft Self-contained Fragments

Status: Draft — authoring and lint support implemented; runtime execution not implemented

Version: `tesseraft.fragment/v1`

Self-contained fragments are portable **multi-node subgraph** packages with a declared boundary contract. A fragment owns its internal graph and assets; an importing workflow owns the inclusion state id, bindings, outgoing transitions, and eventual path namespace.

> **Current safety boundary:** fragment packages can be read, linted, discovered, and imported as authoring stubs. A workflow containing `{:type :fragment}` can pass lint but cannot run: the runner has no `:fragment` dispatch and currently fails with `No matching clause: :fragment`. Do not use fragments in production workflows yet.

This document distinguishes the implemented P1.4 surface from the target executable contract. The ordered implementation prompts are in [FRAGMENT_IMPLEMENTATION_PROMPTS.md](FRAGMENT_IMPLEMENTATION_PROMPTS.md).

## Current implementation status

| Capability | State |
|---|---|
| EDN fragment package parsing | Implemented |
| Package and internal-subgraph lint | Implemented |
| Inclusion input/outcome diagnostics | Implemented |
| Asset validation and collision-safe copying | Implemented |
| Project/global/example discovery helpers | Implemented |
| `tesseraft fragment lint` | Implemented |
| `tesseraft fragment import` authoring stub | Implemented |
| Equivalent JSON package input | Not implemented |
| JSON Schema enforcement | Not wired into the linter |
| Required outcome/exit enforcement when omitted | Incomplete |
| Parameter, version, and prefix semantics | Incomplete or not implemented |
| Boundary resource projection into workflow lint | Not implemented |
| Runtime fragment execution | Not implemented |
| Public fragment control-plane API / Studio catalog | Not implemented |
| Fragment gallery | Deferred (roadmap P1.5) |
| Fragment export/extraction | Deferred (roadmap P4.3) |

P1.4 is complete in its deliberately bounded sense: spec/linter/docs, discovery helpers, one fixture, and `fragment lint|import`. It did not deliver runtime execution.

## Implemented package shape

The operational package format is currently EDN:

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
                     :done {:type :terminal :status :success}
                     :failed {:type :terminal :status :failure}}}}
```

Required top-level fields currently enforced are `:api-version`, `:kind`, `:metadata`, `:interface`, and `:fragment`. The internal fragment requires `:initial` and `:states`.

`schemas/fragment-package.schema.json` describes a JSON-shaped package, but it is not currently loaded by fragment lint. JSON values are not normalized into the keyword ids, node types, effects, and outcome set expected by the Clojure linter. Treat EDN as the only operational input format until normalization is implemented.

## Boundary contract

### Inputs

`:interface :inputs` describes values supplied by an importing workflow. Inclusion lint currently verifies that inputs whose contracts are considered required are present in the inclusion node's `:inputs` map.

Current limitations:

- unknown input bindings are not rejected;
- binding value types are not checked;
- bindings are not made available to runtime because fragment execution is absent.

### Parameters

`:interface :parameters` describes configurable fragment behavior and defaults. Package lint synthesizes inputs and parameters into the internal template-variable environment so internal prompt/template checks can resolve them.

Current inclusion lint does not validate required parameters, defaults, unknown parameters, or value types. Parameter data on an inclusion node is presently declarative only.

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

Current limitation: package boundary `:requirements :resources` is **not projected** onto the workflow's `{:type :fragment}` inclusion node. Workflow resource flow reads only the inclusion node's own `:resources`. A downstream node that requires a package-declared output therefore reports `resource-missing-producer` unless the importer duplicates an equivalent production manually.

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

- `:fragment` selects a package by metadata name;
- keyword `:scope` can restrict lookup to project, global, or examples/configured roots;
- project packages take precedence over global packages, which take precedence over examples by default;
- required interface input names are checked;
- transition outcomes are checked against the interface;
- broken package lint is surfaced as one aggregate inclusion error.

Documented or plausible fields that are not yet operational:

- `:version` does not pin or validate the resolved package version;
- `:prefix` does not namespace assets or runtime artifacts;
- parameter contracts are not enforced;
- package boundary resources are not projected;
- no fragment outcome can be produced at runtime.

The importing workflow ultimately needs to own the state id, scope/version selection, explicit bindings, path prefix, outgoing outcome transitions, and collision handling. Those target semantics are not all implemented in v1 today.

## Discovery and control-plane state

Fragment packages use the same filesystem scope convention as workflows and nodes:

- `examples/fragments/<name>/fragment.edn`
- `~/.tesseraft/fragments/<name>/fragment.edn` (`TESSERAFT_HOME` is honored)
- `.tesseraft/fragments/<name>/fragment.edn`

Generic control-plane discovery and resolution helpers exist, including precedence/conflict handling. There are no public fragment list/detail/graph routes and no Studio catalog surface yet.

## Local CLI

Validate a package:

```bash
./bin/tesseraft fragment lint path/to/fragment.edn
./bin/tesseraft fragment lint path/to/fragment.edn --format json --strict
```

Import a package as an authoring stub:

```bash
./bin/tesseraft fragment import path/to/fragment.edn workflow.edn \
  --as run-tests --next done
```

Import currently:

1. lints the package;
2. refuses unsafe, missing, or conflicting assets;
3. copies declared assets into the workflow package;
4. inserts a node containing `:type`, `:fragment`, and optional `:next`;
5. runs workflow lint in memory;
6. deliberately tolerates expected authoring-pending diagnostics such as missing bindings or incomplete outcomes;
7. writes the workflow stub.

The user must still add inputs, parameters, and outcome transitions. The resulting workflow may not pass lint. Import is not runtime composition.

`fragment export` is explicitly deferred to P4.3 and exits without extracting anything.

## Runtime behavior

There is no runtime fragment boundary implementation. Starting a lint-valid fragment workflow succeeds, but stepping the fragment node records `node.started`, then `node.failed` with `No matching clause: :fragment`.

Runtime implementation must eventually define:

- input and parameter binding;
- package/version resolution pinned to the run;
- internal state, attempts, rounds, and max-round behavior;
- namespaced prompt/schema/command asset resolution;
- namespaced output artifacts and exposed exit outputs;
- terminal-to-outcome selection;
- nested events and inspection;
- mock executor behavior;
- pause/resume, approvals, cancellation, recovery, and orphan handling;
- whether nested fragments are forbidden or supported.

Until those semantics land with tests, a fragment-containing workflow must be treated as lintable authoring data only.

## Fixture and tests

The single fixture is:

```text
examples/fragments/test-fix-loop/
  fragment.edn
  prompts/fix.md.tmpl
  schemas/status.schema.json
```

It proves package lint and import scaffolding. It does **not** prove runtime behavior; its deterministic `lint` and `test` nodes use `:noop/succeed`, and the package is never executed as a fragment.

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
