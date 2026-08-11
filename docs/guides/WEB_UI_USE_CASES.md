# Web UI use cases

Status: Current

| Intent | Surface | Authoritative outcome |
| --- | --- | --- |
| Understand or lint a workflow | Workflows / Studio | normalized package and Clojure linter diagnostics |
| Edit nodes, transitions, prompts, or assets | Studio | semantic draft until completed save; then explicit package files |
| Discover reusable packages and capabilities | Workflows / Studio | discovery metadata and capability catalogs |
| Start and follow a run | Runs | versioned run directory, state, and append-only events |
| Inspect attempt output and failures | Runs | artifacts, attempt records, and event evidence |
| Decide an approval | Runs | durable approval decision plus `approval.decided` event |
| Step, resume, retry, cancel, or delete | Runs | runtime/control-plane operation with single-writer checks |
| Configure project integrations | Settings | descriptor `connections.code-host` and `connections.work-tracker` |
| Choose personal UI/model defaults | Settings | versioned user preferences |
| Set Git authorship | Settings | user default or project override in the Git identity store |
| Diagnose local readiness | Settings / Doctor | redacted static/read-only readiness report |
| Chat through Pi locally | Pi Sessions | configured adapter session and event stream |

The UI may improve presentation, filtering, and authoring assistance without becoming a second authority. A browser draft cannot execute; a filter cannot change run history; a cached catalog cannot add a runtime capability.
