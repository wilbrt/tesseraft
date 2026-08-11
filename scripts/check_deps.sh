#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/toolchain.sh
source "$SCRIPT_DIR/toolchain.sh"

profile="${1:-core}"
case "$profile" in
  core) tools=(babashka) ;;
  web) tools=(babashka nodejs npm) ;;
  test|e2e) tools=(babashka nodejs npm python) ;;
  *) echo "usage: scripts/check_deps.sh [core|web|test|e2e]" >&2; exit 2 ;;
esac

actual_version() {
  case "$1" in
    babashka) bb --version | awk '{print $NF}' | sed 's/^v//' ;;
    nodejs) node --version | sed 's/^v//' ;;
    npm) npm --version ;;
    python) python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' ;;
  esac
}

command_name() {
  case "$1" in
    babashka) printf 'bb\n' ;;
    nodejs) printf 'node\n' ;;
    python) printf 'python3\n' ;;
    *) printf '%s\n' "$1" ;;
  esac
}

missing=0
for tool in "${tools[@]}"; do
  cmd="$(command_name "$tool")"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "missing: $cmd" >&2
    missing=1
  else
    expected="$(toolchain_version "$tool")"
    actual="$(actual_version "$tool")"
    if [[ "$actual" != "$expected" ]]; then
      echo "version mismatch: $cmd expected $expected, found $actual ($(command -v "$cmd"))" >&2
      missing=1
    else
      echo "ok: $cmd $actual -> $(command -v "$cmd")"
    fi
  fi
done

if [[ "$profile" == "e2e" && "$missing" -eq 0 ]]; then
  expected_playwright="$(node -p 'require("./package.json").devDependencies["@playwright/test"]')"
  actual_playwright="$(node -p 'require("@playwright/test/package.json").version' 2>/dev/null || true)"
  if [[ "$actual_playwright" != "$expected_playwright" ]]; then
    echo "version mismatch: Playwright expected $expected_playwright, found ${actual_playwright:-missing}" >&2
    missing=1
  else
    echo "ok: Playwright $actual_playwright"
  fi
fi
exit "$missing"
