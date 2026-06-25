#!/usr/bin/env bash
set -euo pipefail
missing=0
for cmd in bb; do
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "missing: $cmd" >&2
    missing=1
  else
    echo "ok: $cmd -> $(command -v "$cmd")"
  fi
done
exit "$missing"
