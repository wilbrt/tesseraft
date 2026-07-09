# Tesseraft Self-contained Fragments

Status: Draft  
Version: `tesseraft.fragment/v1`

Self-contained fragments are portable **multi-node subgraph** packages with a declared
**boundary contract**: inputs, parameters, outputs, outcomes, and resource
consumption/production. A fragment owns its internal subgraph; an importing workflow
owns integration. The package contract is the durable boundary.

This is the multi-node extension of the single-node contract in
[`docs/NODES.md`](NODES.md). Nodes and fragments share the same scope model and resource
vocabulary.

## Goals

A fragment package should contain enough information to validate one reusable subgraph
without requiring the importing workflow. A compliant implementation must be able to:

- parse a fragment package without side effects,
- validate the package, its internal subgraph, and its referenced assets as one unit,
- lint a workflow that *includes* the fragment as a boundary contract call — **without
  re-running the fragment's internal proof obligations at every import site**,
- copy/import the fragment into a workflow package as a `{:type :fragment}` boundary node.

## Non-goals

- The public registry protocol (deferred).
- Runner execution/inlining of fragments (out of scope for v1; the runner treats
  `{:type :fragment}` as an opaque boundary node for now).
- Broad example rewrites / a fragment gallery (see the roadmap; P1.5).
- Extract-fragment refactor UI / boundary inference from cut edges (P4.3).

## Package shape

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
                :handlers [:git/ensure-branch]
                :tools [:read :bash :write :grep]
                :secrets []
                :template-vars ["inputs.repo-root" "inputs.test-cmd"
                                "parameters.max-rounds" "run.round"]
                :resources {:requires [{:kind :input :name "repo-root" :mode :reusable}
                                       {:kind :input :name "test-cmd" :mode :reusable}
                                       {:kind :capability :name "pi-cli"}]
                            :produces [{:kind :artifact :name "status" :path "status/status.json"}
                                       {:kind :issue-file :name "issues" :path "issues/issues.json"}]}}
 :assets {:prompts ["prompts/fix.md.tmpl"]
          :schemas ["schemas/status.schema.json"]}
 :fragment {:initial :lint
            :defaults {:max-rounds 3 :state-timeout "10m"}
            :entry {:inputs [:repo-root :test-cmd]
                    :parameters [:max-rounds :base-branch]}
            :exit [{:on :pass :produces {:status "status/status.json"}}
                   {:on :fail :produces {:status "status/status.json"
                                         :issues "issues/issues.json"}}]
            :states {:lint   {...}
                     :test   {...}
                     :fix    {...}
                     :done   {:type :terminal :status :success}
                     :failed {:type :terminal :status :failure}}}}
```

Required top-level fields are `:api-version`, `:kind`, `:metadata`, `:interface`, and
`:fragment`.

### Boundary contract (`:interface`)

- `:inputs` / `:parameters` — bindable from the importing workflow. Inputs with
  `:required true` must be bound at inclusion time.
- `:outputs` — artifacts the fragment produces at exit. Required outputs must be produced
  on **every** `:exit` path; optional outputs may be absent.
- `:outcomes` — a non-empty set of keywords the fragment may exit with (e.g.
  `#{:pass :fail}`). Outcomes drive the importing workflow's transitions, exactly like
  agent-node `:status` values drive `:when` transitions.

### Internal subgraph (`:fragment`)

- `:initial` — internal entry state (must exist in `:states`).
- `:defaults` / `:policies` — scoped to the internal subgraph (e.g. `:max-rounds` to
  bound internal cycles).
- `:entry :inputs` / `:entry :parameters` — names from `:interface` bound at inclusion
  time; they become template vars inside the fragment.
- `:exit` — vector of `{:on <outcome> :produces {...}}` mapping each declared outcome to
  the artifacts produced on that exit path. Every `:interface :outcomes` member must have
  an `:exit` entry, and `:produces` must satisfy required `:interface :outputs`.
- `:states` — internal nodes using the same node types and fields as workflow states,
  **except** routing out of the fragment is expressed via terminal states whose `:status`
  corresponds to an `:interface :outcomes` member. The fragment owns internal transitions
  and does **not** name importing-workflow states.

### Requirements and assets

`:requirements` and `:assets` mirror the node package contract (see
[`docs/NODES.md`](NODES.md)). `:requirements :resources` is the boundary-level contract
the importer must satisfy and is linted as proof evidence. Internal-only resources are
proven within the subgraph and are **not** re-checked at the import site.

## Inclusion model

A workflow includes a fragment at a state id via a new `{:type :fragment}` node:

```edn
:run-tests
{:type :fragment
 :fragment "test-fix-loop"
 :scope :project            ;; optional; default discovery
 :version "0.1.0"           ;; optional pin
 :inputs {:repo-root "{{inputs.repo-root}}"
          :test-cmd "bb test"}
 :parameters {:max-rounds 3 :base-branch "{{inputs.base-branch}}"}
 :prefix "test-fix/"        ;; artifact/path prefix
 :transitions [{:when {:fragment/outcome "pass"} :next :pr}
               {:when {:fragment/outcome "fail"} :effects [:merge-issues] :next :abort}]}
```

The importing workflow owns:

- the state id under which the fragment is referenced,
- binding of workflow inputs/defaults/artifacts to `:interface :inputs`/`:parameters`,
- exit transitions keyed by `{:fragment/outcome "<outcome>"}`,
- asset destination prefix and artifact path prefix (to avoid collisions).

The linter treats `{:type :fragment}` as a **boundary contract call**, not as an inlined
subgraph to re-prove internally. This is the key property: **inclusion lints the boundary
contract without duplicating internal proof obligations.** Resource flow at the import
site only considers the fragment's boundary `:requires`/`:produces`.

## Linter behavior

`lint-fragment-package` mirrors `lint-node-package`:

1. Top-level checks: required keys, `tesseraft.fragment/v1`, `:kind :fragment`,
   `:metadata` map with non-blank `:name`, `:interface` map, `:fragment` map.
2. Interface checks: `:outcomes` non-empty keyword set; every `:exit` outcome is in
   `:outcomes` and vice versa; `:exit :produces` satisfies required `:interface :outputs`.
3. Internal subgraph checks (reuse workflow linter primitives over `:fragment :states`):
   node-type/transition/reachability/path-contract checks.
4. Boundary resource checks (reuse `resource-declaration-checks`) on
   `:requirements :resources` and `:fragment :resources`.
5. Asset checks: declared assets exist and are safe relative paths; referenced
   prompt/script/schema assets are declared.

Workflow-level checks for `{:type :fragment}` nodes:

- `fragment-unknown-package` — referenced fragment package not discoverable.
- `fragment-input-binding-missing` — a required `:interface :inputs` input is not bound.
- `fragment-unknown-outcome` — a transition references an outcome not in
  `:interface :outcomes`.
- `fragment-uncovered-outcome` — an `:interface :outcomes` member has no covering
  transition (warning).
- `fragment-internal-lint-failed` — the fragment package itself failed lint (aggregated).

New diagnostic codes are listed in [`docs/LINTER.md`](LINTER.md).

## Local package locations

Fragment packages use the same scope model as workflows and nodes:

- `examples/fragments/<name>/fragment.edn`
- `~/.tesseraft/fragments/<name>/fragment.edn` (`$TESSERAFT_HOME` honored)
- `.tesseraft/fragments/<name>/fragment.edn` (project; highest precedence)

Discovery precedence is lowest → highest (highest wins on name conflicts), identical to
workflows and nodes. The generic `discovery-roots`/`package-files` helpers are reused
unchanged (`:fragments` → `"fragments"`).

## Local CLI

Validate a fragment package:

```bash
./bin/tesseraft fragment lint path/to/fragment.edn
./bin/tesseraft fragment lint path/to/fragment.edn --format json --strict
```

Import a fragment package into a workflow as a `{:type :fragment}` node:

```bash
./bin/tesseraft fragment import path/to/fragment.edn workflow.edn --as run-tests --next done
```

Import validates the fragment, copies assets into the workflow package, inserts the
boundary node, and lints the workflow after writing it. `export` (extracting a subgraph
into a fragment package with boundary inference) is deferred to P4.3.

## Fixture

A minimal, self-contained fixture lives under `examples/fragments/test-fix-loop/`:

```text
examples/fragments/test-fix-loop/
  fragment.edn
  prompts/fix.md.tmpl
  schemas/status.schema.json
```

It is a minimal lint-test-fix loop with two outcomes (`:pass`/`:fail`), one agent fix
node, deterministic lint/test nodes, and terminal exit states. It passes
`tesseraft fragment lint` and is importable into a workflow without external services.