#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/toolchain.sh
source "$SCRIPT_DIR/toolchain.sh"

profile="${1:-core}"
case "$profile" in
  core) tools=(babashka) ;;
  web) tools=(babashka nodejs npm python) ;;
  workflow) tools=(babashka nodejs npm python) ;;
  test|e2e) tools=(babashka nodejs npm python) ;;
  *) echo "usage: scripts/check_deps.sh [core|web|workflow|test|e2e]" >&2; exit 2 ;;
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

same_major_at_least() {
  local actual="$1" expected="$2"
  local version_re='^([0-9]+)\.([0-9]+)\.([0-9]+)$'
  local actual_major actual_minor actual_patch
  local expected_major expected_minor expected_patch

  [[ "$actual" =~ $version_re ]] || return 1
  actual_major="${BASH_REMATCH[1]}"
  actual_minor="${BASH_REMATCH[2]}"
  actual_patch="${BASH_REMATCH[3]}"
  [[ "$expected" =~ $version_re ]] || return 1
  expected_major="${BASH_REMATCH[1]}"
  expected_minor="${BASH_REMATCH[2]}"
  expected_patch="${BASH_REMATCH[3]}"

  (( actual_major == expected_major &&
     (actual_minor > expected_minor ||
      (actual_minor == expected_minor && actual_patch >= expected_patch)) ))
}

version_at_least() {
  local actual="$1" expected="$2"
  local version_re='^([0-9]+)\.([0-9]+)(\.[0-9]+)?$'
  local actual_major actual_minor expected_major expected_minor

  [[ "$actual" =~ $version_re ]] || return 1
  actual_major="${BASH_REMATCH[1]}"
  actual_minor="${BASH_REMATCH[2]}"
  [[ "$expected" =~ $version_re ]] || return 1
  expected_major="${BASH_REMATCH[1]}"
  expected_minor="${BASH_REMATCH[2]}"

  (( actual_major > expected_major ||
     (actual_major == expected_major && actual_minor >= expected_minor) ))
}

compatible_version() {
  local tool="$1" actual="$2" expected="$3"
  if [[ "$tool" == "babashka" && ( "$profile" == "core" || "$profile" == "web" || "$profile" == "workflow" ) ]]; then
    same_major_at_least "$actual" "$expected"
  elif [[ "$tool" == "python" && ( "$profile" == "web" || "$profile" == "workflow" ) ]]; then
    version_at_least "$actual" "$expected"
  else
    [[ "$actual" == "$expected" ]]
  fi
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
    if ! compatible_version "$tool" "$actual" "$expected"; then
      echo "version mismatch: $cmd expected $expected, found $actual ($(command -v "$cmd"))" >&2
      missing=1
    elif [[ "$actual" != "$expected" ]]; then
      echo "ok: $cmd $actual -> $(command -v "$cmd") (compatible; pinned baseline $expected)"
    else
      echo "ok: $cmd $actual -> $(command -v "$cmd")"
    fi
  fi
done

if [[ "$profile" == "workflow" ]]; then
  for cmd in git gh pi opencode; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
      echo "missing: $cmd" >&2
      missing=1
    else
      echo "ok: $cmd -> $(command -v "$cmd")"
    fi
  done
fi

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
