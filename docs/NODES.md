# Tesseraft Self-contained Nodes

Status: Draft  
Version: `tesseraft.node/v1`

Self-contained nodes are portable node packages that can be linted, shared, imported into workflows, and later published through a node repository. The package contract is the durable boundary; repositories are distribution mechanisms over that contract.

## Goals

A node package should contain enough information to understand and validate one reusable workflow node without requiring the original workflow file.

A compliant implementation should be able to:

- parse a node package without side effects,
- validate the package and its referenced assets,
- describe required inputs, outputs, executors, handlers, tools, secrets, and assets,
- copy/import the package into a workflow package with deterministic namespacing,
- export a workflow node and its dependency closure into a package,
- keep the normalized package JSON-compatible.

## Non-goals

The node package format does not define the public repository protocol. A repository may be a local directory, Git repository, HTTP service, or future registry as long as it serves the same package contract.

The first version models a single reusable node. Multi-node reusable subgraphs can be added later as `tesseraft.node-package/v1` or an extension field without weakening the single-node contract.

## Package shape

```edn
{:api-version "tesseraft.node/v1"
 :kind :node
 :metadata {:name "design-with-pi"
            :title "Design with Pi"
            :description "Turn a prompt into a design artifact."
            :version "0.1.0"
            :authors ["Example Author"]
            :tags ["pi" "design"]}
 :interface {:inputs {:prompt {:type :string :required true}}
             :outputs {:status {:schema "schemas/status.schema.json"}
                       :design {:path "design/design.md"}}}
 :requirements {:executors [:pi-cli]
                :handlers []
                :tools [:read :bash]
                :secrets []
                :template-vars ["inputs.prompt" "run.dir"]
                :resources {:requires [{:kind :input :name "prompt" :mode :reusable}
                                       {:kind :capability :name "pi-cli"}]
                            :produces [{:kind :artifact :name "design" :path "design/design.md"}]}}
 :assets {:prompts ["prompts/design.md.tmpl"]
          :scripts []
          :schemas ["schemas/status.schema.json"]}
 :node {:type :agent
        :title "Design"
        :executor :pi-cli
        :prompt-template "prompts/design.md.tmpl"
        :tools [:read :bash]
        :runtime {:timeout "30m"}
        :outputs {:status {:path "design/status.json"
                           :schema "schemas/status.schema.json"
                           :required true}
                  :design {:path "design/design.md" :required true}}}}
```

Required top-level fields are `:api-version`, `:kind`, `:metadata`, and `:node`.

## Node vs workflow integration

The package owns intrinsic node behavior:

- node type,
- executor, handler, or process command,
- prompt/script/schema assets,
- output contracts,
- tool and secret requirements,
- template-variable requirements,
- practical resource requirements and productions when known.

Resource vocabulary is optional in the first node package version and must remain JSON-compatible. Use `:resources` with `:requires`, `:consumes`, and `:produces` groups. Each group is a vector of maps with required `:kind` and `:name` keys plus optional `:path`, `:mode`, `:description`, `:schema`, `:source`, `:tool`, `:secret`, `:handler`, and `:executor` keys. Use it to describe requirements such as inputs, tools, secrets, handlers, executors, existing assets, produced artifacts, consumed resources, reusable resources, one-shot resources, and capability-like permissions. Importing or linting a package may use this vocabulary as static proof evidence, but packages are not required to encode a complete theorem proof.

Package-level `:requirements :resources` describes capabilities and resources needed to reuse the package. Node-level `:node :resources` describes the packaged node's concrete resource transformation. Either declaration is optional.

The importing workflow owns integration:

- state id,
- incoming edges,
- outgoing `:next` or `:transitions`,
- workflow-specific input/default bindings,
- asset destination prefix,
- artifact path prefix if needed,
- collision resolution.

For that reason, package nodes may omit `:next` and `:transitions`. Import tooling should attach workflow-specific transitions.

## Asset closure

All relative files needed by the node should be listed in `:assets` and should exist next to the node package file. Asset paths must be safe relative paths: no absolute paths and no `..` segments.

Common asset classes are:

- `:prompts` — prompt templates used by agent nodes,
- `:scripts` — process command files or helper scripts,
- `:schemas` — JSON schemas referenced by outputs or artifacts.

Assets and resources differ: assets are package files distributed with the node, while resources are runtime or proof objects that a node requires, consumes, or produces. A prompt template can be both an asset and a reusable resource; a generated report is normally a produced artifact resource.

The linter should ensure referenced prompt templates, process scripts, and schemas exist. It should also warn when a known reference is not declared in `:assets`.

## Repository preview

A simple file-backed repository can be layered on top of node packages:

```text
node-repo/
  index.edn
  nodes/
    design-with-pi/
      0.1.0/
        node.edn
        prompts/design.md.tmpl
        schemas/status.schema.json
```

```edn
{:api-version "tesseraft.node-repository/v1"
 :kind :node-repository
 :nodes [{:name "design-with-pi"
          :version "0.1.0"
          :path "nodes/design-with-pi/0.1.0/node.edn"
          :tags ["pi" "design"]}]}
```

Repository commands should come after local package lint/import/export are stable.

## Local CLI

Validate a node package:

```bash
./bin/tesseraft node lint path/to/node.edn
```

Export a workflow state as a self-contained node package:

```bash
./bin/tesseraft node export workflow.edn design --out /tmp/design-node
```

Export copies the referenced asset closure into the output directory and writes `/tmp/design-node/node.edn`. Workflow routing fields, `:next` and `:transitions`, are removed from the package node by default because the importing workflow owns integration.

Import a node package into a workflow:

```bash
./bin/tesseraft node import /tmp/design-node/node.edn workflow.edn --as design-copy --next done
```

Import validates the node package, copies assets into the workflow package, inserts the node under `:states`, and lints the workflow after writing it. If a non-terminal package node has no `:next` or `:transitions`, `--next` is required. Existing states and differing asset files are not overwritten.
