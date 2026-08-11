# Test task graph

Each suite has one owner and runs independently:

| Task | Owner | Scope |
| --- | --- | --- |
| `bb test:unit` | Clojure | focused services, catalogs, migrations, handlers, security |
| `bb test:runtime` | Clojure | runtime transitions and durability |
| `bb test:python` | Python/pytest | CLI, package, fragment, and black-box contracts |
| `npm run test:node` | Node | non-Web cross-language contracts |
| `npm run test:web` | Node/TS | built server, Studio, component, and API contracts |
| `bb test:integration` | Clojure | prepared-build local integrations |
| `npm run test:e2e` | Playwright | browser journeys |
| `bb test:docs` | Babashka | generated status and evidence sync |

`bb test` runs the safe local core plus docs checks. `bb test:all` builds the Web UI once, then runs every suite once. Tests use isolated temporary workspaces and require no live credentials by default.
