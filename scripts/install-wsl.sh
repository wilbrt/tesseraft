#!/usr/bin/env bash
# Bootstrap a Tesseraft checkout inside Ubuntu on WSL 2.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BUILD_WEB=1

usage() {
  cat <<'EOF'
Usage: scripts/install-wsl.sh [--skip-web-build]

Installs the default Tesseraft toolchain, Git, GitHub CLI, the pinned npm
dependencies (including Pi), and the production Web UI inside Ubuntu/WSL 2.

Options:
  --skip-web-build  Install dependencies without building the Web UI.
  -h, --help        Show this help.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-web-build) BUILD_WEB=0; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "install-wsl.sh: unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if [[ "$(uname -s)" != "Linux" ]] || ! command -v apt-get >/dev/null 2>&1; then
  echo "install-wsl.sh: run this script inside an Ubuntu WSL shell" >&2
  exit 3
fi

if [[ -z "${WSL_DISTRO_NAME:-}" ]] && ! grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
  echo "install-wsl.sh: warning: WSL was not detected; continuing on this Debian/Ubuntu host" >&2
fi

if [[ "$EUID" -eq 0 ]]; then
  ROOT=()
else
  command -v sudo >/dev/null 2>&1 || {
    echo "install-wsl.sh: sudo is required when not running as root" >&2
    exit 4
  }
  ROOT=(sudo)
fi

echo "install-wsl.sh: installing base system packages"
"${ROOT[@]}" apt-get update
"${ROOT[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
  ca-certificates curl git gnupg openssh-client python3

if ! command -v gh >/dev/null 2>&1; then
  echo "install-wsl.sh: installing GitHub CLI from its official apt repository"
  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o "$tmp/githubcli-archive-keyring.gpg"
  "${ROOT[@]}" install -d -m 0755 /etc/apt/keyrings
  "${ROOT[@]}" install -m 0644 "$tmp/githubcli-archive-keyring.gpg" \
    /etc/apt/keyrings/githubcli-archive-keyring.gpg
  architecture="$(dpkg --print-architecture)"
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main\n' \
    "$architecture" > "$tmp/github-cli.list"
  "${ROOT[@]}" install -m 0644 "$tmp/github-cli.list" /etc/apt/sources.list.d/github-cli.list
  "${ROOT[@]}" apt-get update
  "${ROOT[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gh
fi

echo "install-wsl.sh: installing the declared Babashka, Node.js, npm, and Python toolchain"
"${ROOT[@]}" "$ROOT_DIR/scripts/install.sh" --install-deps

echo "install-wsl.sh: installing pinned npm dependencies (including Pi)"
cd "$ROOT_DIR"
npm ci

if [[ "$BUILD_WEB" -eq 1 ]]; then
  echo "install-wsl.sh: building the Web UI"
  npm run build:web
fi

echo "install-wsl.sh: verifying workflow dependencies"
./bin/tesseraft doctor --profile workflow

cat <<'EOF'

Tesseraft is installed. Authentication is intentionally interactive; finish it with:

  gh auth login --hostname github.com --git-protocol ssh --web
  gh auth status
  ssh -T git@github.com
  npm exec -- pi

For OpenCode Go, copy an access token from https://opencode.ai/auth. Inside Pi,
run /login, select OpenCode Go, paste the token, then use /model to select a
model. Pi stores the token for future Tesseraft runs. For a non-interactive run,
set OPENCODE_API_KEY instead.
After authentication, start Tesseraft with:

  ./bin/tesseraft web
EOF
