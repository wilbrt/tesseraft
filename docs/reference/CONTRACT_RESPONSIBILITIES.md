# Contract responsibility boundaries

Status: Accepted
Decision date: 2026-08-10
Supersedes: implicit schema/linter overlap
Superseded by: —

JSON Schema owns portable structure: required fields, primitive types, closed public envelopes, and the structural variants for every node type. Boundary codecs own version-specific spelling and conversion between EDN keywords, JSON strings, Clojure kebab-case, and TypeScript domain names.

The standalone linter owns contextual semantics that require knowledge beyond one structural envelope: graph reachability, transition targets, resource/data flow, template references, asset existence, package boundaries, capability availability, and policy rules. Diagnostic families should state whether they are contextual or structurally representable.

The runtime repeats only safety and durability checks that cannot be trusted to authoring-time validation, including confined paths, required outputs, pinned content, process ownership, record versions, and idempotent mutation state.

This division keeps schemas portable, lint diagnostics useful, and runtime effects defensive without establishing competing authorities.
