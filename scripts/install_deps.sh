#!/usr/bin/env bash
set -euo pipefail
if command -v brew >/dev/null 2>&1; then
  brew install babashka
else
  echo "Install Babashka from https://babashka.org/" >&2
fi
