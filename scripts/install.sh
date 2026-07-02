#!/usr/bin/env bash
# Container-friendly Tesseraft installer — installs the WHOLE STACK by default.
#
# Stack = Babashka (CLI: lint/run/node/control-plane) + Node.js/npm (Web UI).
# Use --core-only to skip the Node.js requirement (lint/run/control-plane only).
#
# Usage:
#   scripts/install.sh [options]
#
# Options:
#   --core-only     Do not require Node.js/npm (CLI tier only).
#   --install-node  Auto-install Node.js 22.x via NodeSource on Debian/Ubuntu.
#   --prefix DIR    Install prefix for `bb` (default: /usr/local). Binary -> DIR/bin.
#   --bb-version T  Babashka release tag to install (default: v1.12.218).
#
# Designed to run inside a Dockerfile `RUN` step. Idempotent: skips downloading
# if a matching `bb --version` is already present.
set -euo pipefail

BB_VERSION_DEFAULT="v1.12.218"
PREFIX="/usr/local"
CORE_ONLY=0
INSTALL_NODE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --core-only)    CORE_ONLY=1; shift ;;
    --install-node) INSTALL_NODE=1; shift ;;
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
case "$(uname -m)" in
  x86_64|amd64)    ARCH="amd64" ;;
  aarch64|arm64)   ARCH="aarch64" ;;
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

# --- Node.js tier (whole stack) ------------------------------------------
if [[ "$INSTALL_NODE" -eq 1 ]]; then
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "install.sh: --install-node only supports Debian/Ubuntu (apt-get)" >&2
    exit 4
  fi
  if ! command -v node >/dev/null 2>&1; then
    echo "install.sh: installing Node.js 22.x via NodeSource"
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y --no-install-recommends nodejs
    rm -rf /var/lib/apt/lists/*
  fi
fi

if [[ "$CORE_ONLY" -eq 0 ]]; then
  ok=1
  command -v node >/dev/null 2>&1 || { echo "install.sh: whole-stack install needs node (not on PATH)" >&2; ok=0; }
  command -v npm  >/dev/null 2>&1 || { echo "install.sh: whole-stack install needs npm (not on PATH)" >&2; ok=0; }
  if [[ "$ok" -eq 0 ]]; then
    echo "install.sh: hint: use a node:* base image, pass --install-node on Debian/Ubuntu, or --core-only" >&2
    exit 5
  fi
  echo "install.sh: node $(node --version), npm $(npm --version) available for Web UI"
else
  echo "install.sh: --core-only: Node.js tier skipped"
fi

echo "install.sh: done. Ensure tesseraft/bin is on PATH (export PATH=\$PWD/bin:\$PATH)."
