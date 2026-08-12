#!/usr/bin/env bash
# Container-friendly Tesseraft installer — installs the WHOLE STACK by default.
#
# Stack = Babashka (CLI: lint/run/node/control-plane) + Node.js/npm (Web UI)
# + Python (workflow helpers). Use --core-only to skip the
# Node.js/npm and Python requirements (lint/run/control-plane only).
#
# Usage:
#   scripts/install.sh [options]
#
# Options:
#   --core-only     Do not require Node.js/npm/Python (CLI tier only).
#   --install-deps  Install the declared Node.js release and Python on Debian/Ubuntu.
#   --install-node  Backward-compatible alias for --install-deps.
#   --prefix DIR    Install prefix for `bb` (default: /usr/local). Binary -> DIR/bin.
#   --bb-version T  Override the Babashka release declared in .tool-versions.
#
# Designed to run inside a Dockerfile `RUN` step. Idempotent: skips downloading
# if a matching `bb --version` is already present.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/toolchain.sh
source "$SCRIPT_DIR/toolchain.sh"

BB_VERSION_DEFAULT="v$(toolchain_version babashka)"
NODE_VERSION="$(toolchain_version nodejs)"
NPM_VERSION="$(toolchain_version npm)"
PYTHON_VERSION="$(toolchain_version python)"
PREFIX="/usr/local"
CORE_ONLY=0
INSTALL_DEPS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --core-only)    CORE_ONLY=1; shift ;;
    --install-deps|--install-node) INSTALL_DEPS=1; shift ;;
    --prefix)       PREFIX="$2"; shift 2 ;;
    --bb-version)   BB_VERSION_DEFAULT="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "install.sh: unknown arg: $1" >&2; exit 2 ;;
  esac
done

BB_VERSION="$BB_VERSION_DEFAULT"
BIN_DIR="$PREFIX/bin"
mkdir -p "$BIN_DIR"

# --- Arch detection -------------------------------------------------------
if [[ "$(uname -s)" != "Linux" ]]; then
  echo "install.sh: unsupported OS: $(uname -s) (this installer targets Linux containers and Debian/Ubuntu hosts)" >&2
  exit 3
fi

case "$(uname -m)" in
  x86_64|amd64)    ARCH="amd64"; NODE_ARCH="x64" ;;
  aarch64|arm64)   ARCH="aarch64"; NODE_ARCH="arm64" ;;
  *) echo "install.sh: unsupported arch: $(uname -m)" >&2; exit 3 ;;
esac

# --- Skip if a matching bb is already installed ---------------------------
already=0
if command -v bb >/dev/null 2>&1; then
  installed="$(bb --version 2>/dev/null || true)"
  # `bb --version` prints e.g. "babashka v1.12.218" or just "1.12.218".
  if [[ "$installed" == *"${BB_VERSION#v}"* ]]; then
    echo "install.sh: bb already at ${installed}, skipping download"
    already=1
  fi
fi

if [[ "$already" -eq 0 ]]; then
  base="https://github.com/babashka/babashka/releases/download"
  ver_num="${BB_VERSION#v}"
  tarball="babashka-${ver_num}-linux-${ARCH}-static.tar.gz"
  url="${base}/${BB_VERSION}/${tarball}"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT

  echo "install.sh: downloading $url"
  curl -fsSL "$url" -o "$tmp/$tarball"
  curl -fsSL "$url.sha256" -o "$tmp/$tarball.sha256"

  # GitHub's .sha256 sidecar is a bare hex hash with no filename, so we
  # compare manually rather than relying on `sha256sum -c` line format.
  expected="$(tr -d '[:space:]' < "$tmp/$tarball.sha256")"
  actual="$(sha256sum "$tmp/$tarball" | awk '{print $1}')"
  if [[ "$expected" != "$actual" ]]; then
    echo "install.sh: sha256 mismatch for $tarball" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 6
  fi
  echo "install.sh: sha256 verified ($actual)"

  tar -xzf "$tmp/$tarball" -C "$tmp"
  install -m 0755 "$tmp/bb" "$BIN_DIR/bb"
  echo "install.sh: installed bb -> $BIN_DIR/bb ($($BIN_DIR/bb --version))"
fi

# --- System dependencies (whole stack) -----------------------------------
if [[ "$INSTALL_DEPS" -eq 1 ]]; then
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "install.sh: --install-deps only supports Debian/Ubuntu (apt-get)" >&2
    exit 4
  fi
  apt-get update
  env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 xz-utils
  installed_node="$(node --version 2>/dev/null | sed 's/^v//' || true)"
  if [[ "$installed_node" != "$NODE_VERSION" ]]; then
    node_tarball="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
    node_url="https://nodejs.org/dist/v${NODE_VERSION}"
    node_tmp="$(mktemp -d)"
    echo "install.sh: downloading declared Node.js ${NODE_VERSION}"
    curl -fsSL "$node_url/$node_tarball" -o "$node_tmp/$node_tarball"
    curl -fsSL "$node_url/SHASUMS256.txt" -o "$node_tmp/SHASUMS256.txt"
    expected_node="$(awk -v file="$node_tarball" '$2 == file { print $1; exit }' "$node_tmp/SHASUMS256.txt")"
    actual_node="$(sha256sum "$node_tmp/$node_tarball" | awk '{print $1}')"
    if [[ -z "$expected_node" || "$expected_node" != "$actual_node" ]]; then
      echo "install.sh: sha256 mismatch for $node_tarball" >&2
      echo "  expected: ${expected_node:-missing}" >&2
      echo "  actual:   $actual_node" >&2
      exit 6
    fi
    echo "install.sh: sha256 verified ($actual_node)"
    tar -xJf "$node_tmp/$node_tarball" --strip-components=1 -C "$PREFIX"
    rm -rf "$node_tmp"
  fi
  rm -rf /var/lib/apt/lists/*
fi

if [[ "$CORE_ONLY" -eq 0 ]]; then
  ok=1
  command -v node >/dev/null 2>&1 || { echo "install.sh: whole-stack install needs node (not on PATH)" >&2; ok=0; }
  command -v npm  >/dev/null 2>&1 || { echo "install.sh: whole-stack install needs npm (not on PATH)" >&2; ok=0; }
  command -v python3 >/dev/null 2>&1 || { echo "install.sh: whole-stack install needs python3 (not on PATH)" >&2; ok=0; }
  if [[ "$ok" -eq 0 ]]; then
    echo "install.sh: hint: use a base image with Node.js and Python, pass --install-deps on Debian/Ubuntu, or --core-only" >&2
    exit 5
  fi
  installed_node="$(node --version | sed 's/^v//')"
  if [[ "$installed_node" != "$NODE_VERSION" ]]; then
    echo "install.sh: node version mismatch: expected $NODE_VERSION, found $installed_node" >&2
    echo "install.sh: hint: install the declared toolchain or pass --install-deps on Debian/Ubuntu" >&2
    exit 7
  fi
  installed_npm="$(npm --version)"
  if [[ "$installed_npm" != "$NPM_VERSION" ]]; then
    echo "install.sh: installing declared npm $NPM_VERSION (found $installed_npm)"
    npm install --global "npm@$NPM_VERSION"
  fi
  installed_python="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
  expected_python_major="${PYTHON_VERSION%%.*}"
  expected_python_minor="${PYTHON_VERSION#*.}"
  expected_python_minor="${expected_python_minor%%.*}"
  installed_python_major="${installed_python%%.*}"
  installed_python_minor="${installed_python#*.}"
  installed_python_minor="${installed_python_minor%%.*}"
  if (( installed_python_major < expected_python_major ||
        (installed_python_major == expected_python_major && installed_python_minor < expected_python_minor) )); then
    echo "install.sh: python version mismatch: need >=$PYTHON_VERSION, found $installed_python" >&2
    echo "install.sh: hint: install a supported Python before retrying" >&2
    exit 7
  fi
  echo "install.sh: node $(node --version), npm $(npm --version), python $installed_python available for the whole stack"
else
  echo "install.sh: --core-only: Node.js/npm and Python tiers skipped"
fi

echo "install.sh: done. Ensure tesseraft/bin is on PATH (export PATH=\$PWD/bin:\$PATH)."
