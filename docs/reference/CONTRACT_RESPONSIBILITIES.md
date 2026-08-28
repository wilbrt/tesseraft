# Contract responsibility boundaries

Status: Accepted
Decision date: 2026-08-10
Supersedes: implicit schema/linter overlap
Superseded by: —

JSON Schema owns portable structure: required fields, primitive types, closed public envelopes, and the structural variants for every node type. Boundary codecs own version-specific spelling and conversion between EDN keywords, JSON strings, Clojure kebab-case, and TypeScript domain names.

For resumable agents, schema owns the closed `session` map, its `resumable`
mode, and required continuation-template field. Boundary normalization maps the
JSON string mode to the EDN semantic keyword exactly as it does node types,
executors, effects, and tools.

The standalone linter owns contextual semantics that require knowledge beyond one structural envelope: graph reachability, transition targets, resource/data flow, template references, asset existence, package boundaries, capability availability, and policy rules. Diagnostic families should state whether they are contextual or structurally representable.

Accordingly, resumable-session lint owns executor capability, resolved
continuation assets and template variables, safe generated-prompt paths, and
the requirement that continuation and required output paths are stamped with
`{{run.attempt}}`.

The runtime repeats only safety and durability checks that cannot be trusted to authoring-time validation, including confined paths, required outputs, pinned content, process ownership, record versions, and idempotent mutation state. For resumable sessions it additionally owns the exact run/state binding, configuration hash, legal lifecycle transitions, prompt delivery evidence, and explicit executor reference. Those checks implement the authored policy; they do not infer a second workflow interpretation.

This division keeps schemas portable, lint diagnostics useful, and runtime effects defensive without establishing competing authorities.
