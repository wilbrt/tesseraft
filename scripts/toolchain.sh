#!/usr/bin/env bash
# Shared reader for Tesseraft's authoritative toolchain declaration.

toolchain_root() {
  cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd
}

toolchain_file() {
  printf '%s/.tool-versions\n' "$(toolchain_root)"
}

toolchain_version() {
  local tool="${1:?tool name is required}"
  local file
  file="$(toolchain_file)"
  awk -v tool="$tool" '$1 == tool { print $2; found = 1; exit } END { if (!found) exit 1 }' "$file"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  case "${1:-}" in
    get)
      toolchain_version "${2:?usage: scripts/toolchain.sh get TOOL}"
      ;;
    file)
      toolchain_file
      ;;
    *)
      echo "usage: scripts/toolchain.sh <get TOOL|file>" >&2
      exit 2
      ;;
  esac
fi
