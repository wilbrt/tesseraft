# Validated prior-run lessons

This is reviewed workflow guidance, not runtime-mutable memory.

- Measure correction progress by changed failing evidence and changed work, not by attempts completed.
- Supply implementation with only the newest actionable failure. Older issues remain historical evidence and must not be merged into an active backlog.
- Never retry unchanged input indefinitely. Repeated failure fingerprints or unchanged work require independent supervision or human intervention.
- Detect behavior that is already satisfied before trying to manufacture a red test. The FI2 Canon run repeated an already-satisfied scenario through round 50.
- Keep authoritative tests in deterministic process nodes. Agents may author tests but may not execute tests, lint, builds, `bb`, or `npm`.
- Run cheap focused and repository checks before expensive browser checks, and stop at the first failing tier.
- Expected test failures are workflow outcomes; malformed plans, runner crashes, missing protocols, and other infrastructure faults are external failures.
- Passing deterministic gates does not replace semantic review. Prior reviews found credential isolation, malformed configuration, branch collision, registry integrity, and recovery defects after gates passed.
- Review current code and current evidence. Do not repeat findings whose acceptance criteria are already satisfied.
- Preserve the validated prefix when redirecting a correction strategy.
- Keep generic contracts generic: do not silently assume a `ticket` when a workflow uses another work-item identity.
- Runtime agents may not edit workflow definitions or promote run observations into this file. Updating these lessons is a separate reviewed authoring change.

## FI2-DIP1 reviewed observations

The first Design in Practice run completed FI2 and opened PR #87 at round 5 with 9 agent sessions, 4 feedback cycles, and $8.59 recorded executor cost. Two sessions were avoidable: implementation chose test and fixture names that differed from the immutable validation plan. Future implementation prompts must inspect and preserve every declared validation entrypoint before choosing file names.

The same two failures had different exact fingerprints but one common class: missing declared validation entrypoints. Record normalized failure classes for common-cause analysis while retaining exact fingerprints for evidence routing.

Independent review found policy-allowlist parity, documentation-scope, and portable-key-collision defects after deterministic tests passed. Keep semantic review mandatory.

Deterministic PR assembly worked but led with the newest correction summary rather than the complete change. Build PR summaries from the design problem/direction, final validation, final review, and diff—not from the latest correction alone.
