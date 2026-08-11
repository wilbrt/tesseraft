# Security policy

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability or include secrets in
logs, screenshots, fixtures, or reproduction archives. Use the repository's
private vulnerability-reporting feature under the GitHub **Security** tab. If
private reporting is unavailable, contact the repository owner privately and
share only the minimum redacted reproduction needed to investigate.

Include the affected version or commit, impact, required preconditions, and a
safe reproduction. Reports involving credential disclosure, path traversal,
arbitrary command execution, unsafe non-loopback exposure, or durable-state
corruption receive priority.

## Supported version

Security fixes target the current `main` branch. The project does not promise
backports for earlier commits or unreleased snapshots.

## Security boundaries

Tesseraft executes local workflow effects by design. Treat workflow and package
content as executable input. Keep the Web server loopback-bound unless the
explicit exposure acknowledgement and an appropriate external access-control
boundary are in place. Store only credential references in repository-owned
files; secret values belong in environment variables, CI stores, or the local
credential store.
