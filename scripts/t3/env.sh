# Sourced by the other scripts in this directory: puts Node 24 and pnpm on
# PATH and defines the isolated dev home. Inside the devenv shell (or any
# shell that already has Node 24) the system Node is used; otherwise Node 24
# is downloaded once into ~/.cache/jhin, so the scripts work on any Linux or
# macOS machine, including a T3 Code host without nix.

set -euo pipefail

JHIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export JHIN_ROOT

# Everything the dev scripts create lives here (gitignored).
JHIN_DEV_DIR="${JHIN_DEV_DIR:-$JHIN_ROOT/.jhin-dev}"
export JHIN_DEV_DIR
mkdir -p "$JHIN_DEV_DIR"

node_major() {
  command -v node >/dev/null 2>&1 || { echo 0; return; }
  node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0
}

if [ "$(node_major)" -lt 24 ]; then
  cache="${XDG_CACHE_HOME:-$HOME/.cache}/jhin"
  case "$(uname -s)" in
    Linux) os=linux ;;
    Darwin) os=darwin ;;
    *) echo "jhin: unsupported OS $(uname -s); install Node 24 yourself" >&2; exit 1 ;;
  esac
  case "$(uname -m)" in
    x86_64 | amd64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) echo "jhin: unsupported CPU $(uname -m); install Node 24 yourself" >&2; exit 1 ;;
  esac
  node_dir="$(ls -d "$cache"/node-v24.*-"$os-$arch" 2>/dev/null | sort -V | tail -n 1 || true)"
  if [ -z "$node_dir" ]; then
    mkdir -p "$cache"
    base="https://nodejs.org/dist/latest-v24.x"
    line="$(curl -fsSL "$base/SHASUMS256.txt" | grep " node-v24.*-$os-$arch.tar.gz\$")"
    sum="${line%% *}"
    file="${line##* }"
    echo "jhin: downloading $file into $cache" >&2
    curl -fsSL "$base/$file" -o "$cache/$file"
    if command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "$cache/$file" | cut -d' ' -f1)"
    else
      actual="$(shasum -a 256 "$cache/$file" | cut -d' ' -f1)"
    fi
    if [ "$actual" != "$sum" ]; then
      rm -f "$cache/$file"
      echo "jhin: checksum mismatch for $file" >&2
      exit 1
    fi
    tar -xzf "$cache/$file" -C "$cache"
    rm -f "$cache/$file"
    node_dir="$cache/${file%.tar.gz}"
  fi
  export PATH="$node_dir/bin:$PATH"
fi

# pnpm at the version pinned in package.json's "packageManager", via corepack.
if ! command -v pnpm >/dev/null 2>&1 || [ "$(pnpm --version 2>/dev/null)" != "$(node -p 'require(process.env.JHIN_ROOT + "/package.json").packageManager.split("@")[1]')" ]; then
  shim_dir="$JHIN_DEV_DIR/bin"
  mkdir -p "$shim_dir"
  if [ ! -x "$shim_dir/pnpm" ]; then
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack enable --install-directory "$shim_dir" pnpm
  fi
  export PATH="$shim_dir:$PATH"
fi
export COREPACK_ENABLE_DOWNLOAD_PROMPT=0

# Installs dependencies when node_modules is missing or older than the lockfile.
ensure_deps() {
  if [ ! -d "$JHIN_ROOT/node_modules" ] || [ "$JHIN_ROOT/pnpm-lock.yaml" -nt "$JHIN_ROOT/node_modules/.modules.yaml" ]; then
    (cd "$JHIN_ROOT" && pnpm install --frozen-lockfile)
  fi
}

# The dev node's home: its own identity, database, logs and config, separate
# from ~/.jhin so experiments never touch a real node.
JHIN_DEV_HOME="${JHIN_DEV_HOME:-$JHIN_DEV_DIR/home}"
export JHIN_DEV_HOME
JHIN_PORT="${JHIN_PORT:-7777}"
export JHIN_PORT

# A fixed access token for the dev home only, so a preview URL can carry it
# (`#token=…`). The dev node listens on 127.0.0.1; never reuse this token for
# a node reachable from other machines.
JHIN_DEV_TOKEN="${JHIN_DEV_TOKEN:-jhin-local-dev-token-for-127-0-0-1-only-000}"
export JHIN_DEV_TOKEN

# Creates the dev home with the dev token and the configured port.
prepare_dev_home() {
  local token_dir="$JHIN_DEV_HOME/data/jhin.auth-token"
  mkdir -p "$token_dir"
  if [ ! -s "$token_dir/token" ]; then
    (umask 077 && printf '%s\n' "$JHIN_DEV_TOKEN" >"$token_dir/token")
  fi
  if [ ! -f "$JHIN_DEV_HOME/config.jsonc" ]; then
    cat >"$JHIN_DEV_HOME/config.jsonc" <<JSONC
// Node config of the dev home created by scripts/t3. Edit freely; it is kept.
{
  "jhin.http": { "port": $JHIN_PORT }
}
JSONC
  fi
}

# Runs the jhin CLI against the dev home.
jhin_dev() {
  node "$JHIN_ROOT/apps/jhin/bin/jhin.js" --home "$JHIN_DEV_HOME" --cwd "$JHIN_ROOT" "$@"
}

# Records the pid of a long-running script so stop.sh can end it.
record_pid() {
  mkdir -p "$JHIN_DEV_DIR/pids"
  echo "$$" >"$JHIN_DEV_DIR/pids/$1.pid"
}
