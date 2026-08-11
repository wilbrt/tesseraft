# Package and namespace boundaries

Tesseraft is one local tool with focused implementation packages rather than separately versioned internal products.

| Boundary | Owner |
| --- | --- |
| `tesseraft.contract` / `tesseraft.spec` | codecs, normalization, schemas, and portable package reads |
| `tesseraft.lint` | semantic static validation and diagnostics |
| `tesseraft.capabilities` | handler and executor catalogs |
| `tesseraft.work-tracker.catalog` | provider metadata, validation, doctor, mock, and live fetch dispatch |
| `tesseraft.project` | descriptor, registry, connections, and resolution primitives |
| `tesseraft.credentials`, `preferences`, `identity` | user-owned versioned stores |
| `tesseraft.control-plane` | project/workflow/run/settings application services |
| `tesseraft.runtime` | state transitions, execution, recovery, and run persistence |
| `tesseraft.persistence` | safe atomic replacement and append primitives |
| `tesseraft.migration` | all persisted compatibility readers and converters |

The public package commands are:

```bash
tesseraft node lint|export|import ...
tesseraft fragment lint|import ...
tesseraft lint ...
tesseraft run ...
tesseraft control-plane ...
tesseraft migrate ...
```

Dependencies point inward toward contracts and catalogs. Runtime storage does not depend on the control plane; integrations receive resolved execution context and do not resolve projects themselves. See the [authority map](../architecture/AUTHORITIES.md).
