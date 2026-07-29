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

## FI3-DIP1 reviewed observations

FI3-DIP1 reached the hard round limit with one minor review finding left after 15 agent sessions, 247 responses, and $15.53 recorded executor cost. The branch and all deterministic evidence were preserved, but the global max-round check ran before `prepare-feedback`, so intervention and run-learning telemetry were unreachable. Future workflows use a soft correction budget routed through intervention plus a higher hard runtime safety cap.

The run made concrete progress across multiple assertions from the same focused check. Because exact fingerprints omitted diagnostics, changing assertions were misclassified as repeated and triggered an unnecessary supervisor session. Exact fingerprints must include a bounded normalized diagnostic signature; failure classes remain separate for common-cause reporting.

The supervisor itself was useful: it identified an invalid import test fixture, preserved the validated implementation prefix, and redirected one precise correction. Keep supervision for genuinely repeated evidence, not merely repeated check titles.

Replacement runs must preserve an explicitly supplied task branch rather than inventing a new branch, so bounded work can continue without mutating or repinning the failed run.

FI3-DIP2 continued the preserved branch and opened PR #89 in round 1 with 3 agent sessions, 38 responses, and $2.28 recorded executor cost. Its focused correction, deterministic validation, and whole-diff review all passed without feedback or supervision.

A replacement design correctly focused on the final defect, but that caused initial PR assembly to present the correction rather than the complete 11-commit branch. On replacement runs, require the design PR title to name the complete base-to-branch change, synthesize the summary from the whole-diff review, and label the focused design problem as the final correction.

## FI4-DIP1 reviewed observations

FI4-DIP1 opened PR #90 in round 3 with 6 agent sessions, 100 responses, and $6.27 recorded executor cost. Two distinct correction cycles—an ambient resource-kind mismatch followed by pathless alias and documentation findings—routed directly to implementation with zero supervisor sessions. This supports diagnostic-sensitive exact fingerprints while retaining normalized failure classes.

Normal runs may carry a JSON `null` branch input. Replacement detection must require a nonblank string; stringifying null incorrectly labels ordinary PR metadata as a replacement/final-correction body. Keep explicit replacement semantics type-sensitive.

## FI5-DIP1 reviewed observations

FI5-DIP1 preserved three clean implementation commits after focused transactional checks and strict fixture lint passed. The client controlling round-3 repository validation was interrupted; the process node stopped without a result artifact, and runtime correctly terminated the run as orphaned rather than replaying repository commands or forging completion. Continue from the preserved branch through an explicit replacement run.

An operator-authorized executor handoff moved subsequent Design-in-Practice agent work to the Claude Code subscription executor. Use Opus for design/review/supervision and Sonnet for implementation/corrections, while retaining process-owned validation. Claude provider and thinking pins are intentionally absent because the executor ignores them.

FI5-DIP2 continued the preserved branch and opened PR #91 in round 4 with 10 Claude sessions, three feedback cycles, and one supervision handoff. Claude Code does not expose token/cost totals through the current executor, so record session count and stop on an explicit CLI limit failure rather than reporting invented usage.

Claude review twice wrapped issues in an object and invented field aliases, while the feedback process expected the canonical top-level array. This silently emptied or degraded correction evidence and caused one no-op implementation round. Review prompts now require the exact schema fields; feedback ingestion defensively accepts the observed wrapper and normalizes common aliases. Preserve output-schema validation as a future runtime hardening opportunity.

## FI6 reviewed observations

FI6-DIP1 was interrupted during its first Sonnet implementation and correctly terminated as orphaned with no status artifact. Preserve partial agent-authored work as code evidence, not a fabricated node result. FI6-DIP2 reused that branch with the exact original ticket prompt and no mid-run operator prompt injection.

FI6-DIP2 opened PR #92 in round 5 with 10 Claude sessions, four workflow-owned feedback cycles, and zero supervision handoffs. Focused runtime checks and repository validation passed, and Opus whole-diff review converged without operator-authored correction context. This is clean evidence for the Claude workflow; the executor still exposes session counts but not token/cost totals.

## FI7-DIP1 reviewed observations

FI7-DIP1 opened PR #93 in round 5 with 9 Claude sessions, four workflow-owned feedback cycles, and zero supervision handoffs. The run progressed from focused validation failures through semantic review corrections using only authored feedback transitions; no operator prompt was injected. Claude did not report a usage limit.
