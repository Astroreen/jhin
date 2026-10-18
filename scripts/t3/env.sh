# shellcheck shell=bash
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

# The Node release downloaded when no Node 24 is on PATH. Bump deliberately.
JHIN_NODE_VERSION="${JHIN_NODE_VERSION:-24.22.0}"

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
  name="node-v$JHIN_NODE_VERSION-$os-$arch"
  node_dir="$cache/$name"
  if [ ! -x "$node_dir/bin/node" ]; then
    mkdir -p "$cache"
    base="https://nodejs.org/dist/v$JHIN_NODE_VERSION"
    sum="$(curl -fsSL "$base/SHASUMS256.txt" | grep " $name.tar.gz\$" | cut -d' ' -f1)"
    # A private staging directory, renamed into place at the end: two scripts
    # starting at once never extract over each other.
    staging="$(mktemp -d "$cache/.download.XXXXXX")"
    trap 'rm -rf "$staging"' EXIT
    echo "jhin: downloading $name into $cache" >&2
    curl -fsSL "$base/$name.tar.gz" -o "$staging/$name.tar.gz"
    if command -v sha256sum >/dev/null 2>&1; then
      actual="$(sha256sum "$staging/$name.tar.gz" | cut -d' ' -f1)"
    else
      actual="$(shasum -a 256 "$staging/$name.tar.gz" | cut -d' ' -f1)"
    fi
    if [ -z "$sum" ] || [ "$actual" != "$sum" ]; then
      echo "jhin: checksum mismatch for $name.tar.gz" >&2
      exit 1
    fi
    tar -xzf "$staging/$name.tar.gz" -C "$staging"
    mv "$staging/$name" "$node_dir" 2>/dev/null || true # lost the race: the other copy is identical
    rm -rf "$staging"
    trap - EXIT
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
[ -n "${JHIN_PORT:-}" ] && JHIN_PORT_SET=1
JHIN_PORT="${JHIN_PORT:-7777}"
export JHIN_PORT

# Creates the dev home: a marker (so reset.sh only ever deletes a dev home)
# and a config with the port. The access token is random per home, created
# by the auth plugin on first start; `dev_token` reads it.
prepare_dev_home() {
  mkdir -p "$JHIN_DEV_HOME"
  touch "$JHIN_DEV_HOME/.jhin-dev-home"
  if [ ! -f "$JHIN_DEV_HOME/config.jsonc" ]; then
    cat >"$JHIN_DEV_HOME/config.jsonc" <<JSONC
// Node config of the dev home created by scripts/t3. Edit freely; it is kept.
{
  "jhin.http": { "port": $JHIN_PORT }
}
JSONC
  elif [ -n "${JHIN_PORT_SET:-}" ] && ! grep -q "\"port\": *$JHIN_PORT\b" "$JHIN_DEV_HOME/config.jsonc"; then
    echo "jhin: JHIN_PORT=$JHIN_PORT is ignored, $JHIN_DEV_HOME/config.jsonc sets the port" >&2
  fi
}

dev_token() {
  cat "$JHIN_DEV_HOME/data/jhin.auth-token/token"
}

# Starts the dev node in the background with its output on this terminal and
# sets NODE_PID and NODE_URL (http://host:port) once the node printed its RPC
# address. Fails if the node exits before that.
start_dev_node() {
  local fifo line
  fifo="$(mktemp -u "$JHIN_DEV_DIR/node-out.XXXXXX")"
  mkfifo "$fifo"
  node "$JHIN_ROOT/apps/jhin/bin/jhin.js" --home "$JHIN_DEV_HOME" --cwd "$JHIN_ROOT" serve "$@" >"$fifo" 2>&1 &
  NODE_PID=$!
  exec {node_out}<"$fifo"
  rm -f "$fifo"
  NODE_URL=""
  while IFS= read -r line <&"$node_out"; do
    printf '%s\n' "$line"
    case "$line" in
      "rpc: ws://"*) NODE_URL="http://${line#rpc: ws://}" && NODE_URL="${NODE_URL%/rpc}" && break ;;
    esac
  done
  if [ -z "$NODE_URL" ]; then
    wait "$NODE_PID" || true
    echo "jhin: the node exited before it was ready" >&2
    exit 1
  fi
  # Keep forwarding the node's output.
  cat <&"$node_out" &
}

# Records this script's pid so stop.sh can end it; refuses a second instance.
# The pid file is removed when the script exits.
record_pid() {
  local file="$JHIN_DEV_DIR/pids/$1.pid"
  mkdir -p "$JHIN_DEV_DIR/pids"
  if [ -f "$file" ] && is_ours "$(cat "$file")" "$1"; then
    echo "jhin: $1 is already running (pid $(cat "$file")); run scripts/t3/stop.sh first" >&2
    exit 1
  fi
  echo "$$" >"$file"
  # shellcheck disable=SC2154 # job is the loop variable inside the trap string
  trap 'rm -f "'"$file"'"; for job in $(jobs -p); do kill_tree "$job"; done' EXIT
  trap 'exit 130' INT TERM
}

# Ends a process and all its descendants.
kill_tree() {
  local child
  for child in $(pgrep -P "$1" 2>/dev/null); do
    kill_tree "$child"
  done
  kill "$1" 2>/dev/null || true
}

# True when pid is alive and is scripts/t3/<name>.sh of this checkout, so a
# stale pid file never matches an unrelated process that reused the pid.
is_ours() {
  kill -0 "$1" 2>/dev/null || return 1
  ps -o args= -p "$1" 2>/dev/null | grep -q "scripts/t3/$2.sh" || return 1
  if [ -d "/proc/$1" ]; then
    [ "$(readlink "/proc/$1/cwd")" = "$JHIN_ROOT" ] || return 1
  fi
}
