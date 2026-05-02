#!/bin/bash
# Mirror OpenClaw bundled / managed skills into the agent's sandbox workspace.
#
# Why: in rw-workspace mode, OpenClaw's built-in syncSkillsToWorkspace is
# (deliberately) skipped to avoid wiping hand-authored skills. But the prompt
# builder still advertises every skill with its host-side absolute path, and
# the sandboxed `read` tool refuses paths outside the workspace root. Result:
# the agent is told about bundled skills it cannot read.
#
# This script copies eligible skill directories from the openclaw npm install
# (and ~/.openclaw/skills/ if present) into <workspace>/skills/<name>/ with a
# `.openclaw-mirror` marker. No-clobber by default: if the destination dir
# exists *without* our marker, it's treated as user-authored and skipped.
# Marker-owned dirs are refreshed when their content fingerprint changes
# (e.g. after `npm i -g openclaw@latest`).
#
# Idempotent. Safe to run repeatedly. Best-effort: exits 0 even on per-skill
# errors so the LaunchAgent never goes red.

set -u

usage() {
  cat <<'USAGE'
Usage: mirror-openclaw-skills.sh [--dry-run] [--verbose] [--help]

Options:
  --dry-run   Print what would be done without modifying anything.
  --verbose   Log every skill considered (default: only changes/skips with reason).
  --help      Show this help.

Environment overrides (rarely needed):
  OPENCLAW_WORKSPACE_DIR   Defaults to ~/.openclaw/workspace
  OPENCLAW_NPM_ROOT        Defaults to `npm root -g`
  OPENCLAW_LOG_FILE        Defaults to ~/.openclaw/logs/skills-mirror.log
USAGE
}

DRY_RUN=0
VERBOSE=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --verbose) VERBOSE=1 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; usage >&2; exit 2 ;;
  esac
done

export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin"

WORKSPACE_DIR="${OPENCLAW_WORKSPACE_DIR:-$HOME/.openclaw/workspace}"
LOG_FILE="${OPENCLAW_LOG_FILE:-$HOME/.openclaw/logs/skills-mirror.log}"
SKILLS_DEST="$WORKSPACE_DIR/skills"
MARKER_NAME=".openclaw-mirror"

mkdir -p "$(dirname "$LOG_FILE")"

log() {
  local ts msg
  ts="$(date -Iseconds)"
  msg="$*"
  if [ "$DRY_RUN" -eq 1 ]; then
    msg="[dry-run] $msg"
  fi
  echo "$ts $msg" | tee -a "$LOG_FILE" >&2
}

vlog() {
  if [ "$VERBOSE" -eq 1 ]; then
    log "$@"
  else
    local ts="$(date -Iseconds)"
    echo "$ts $*" >> "$LOG_FILE"
  fi
}

# Resolve npm global root.
NPM_ROOT="${OPENCLAW_NPM_ROOT:-}"
if [ -z "$NPM_ROOT" ]; then
  if command -v npm >/dev/null 2>&1; then
    NPM_ROOT="$(npm root -g 2>/dev/null || true)"
  fi
fi

if [ -z "${NPM_ROOT:-}" ] || [ ! -d "$NPM_ROOT" ]; then
  log "ERROR: cannot resolve npm global root (set OPENCLAW_NPM_ROOT to override). Aborting."
  exit 0
fi

OPENCLAW_VERSION="unknown"
# `openclaw` is installed under `npm prefix -g`/bin (older npm shipped
# `npm bin -g` for this; recent npm dropped the subcommand).
if command -v npm >/dev/null 2>&1; then
  npm_prefix="$(npm prefix -g 2>/dev/null || true)"
  if [ -n "$npm_prefix" ] && [ -d "$npm_prefix/bin" ]; then
    export PATH="$npm_prefix/bin:$PATH"
  fi
fi

if command -v openclaw >/dev/null 2>&1; then
  # Extract a version-like token (e.g. "2026.4.21") from `openclaw --version`,
  # falling back to "unknown" if anything looks off.
  OPENCLAW_VERSION="$(openclaw --version 2>/dev/null \
    | head -n1 \
    | grep -oE '[0-9]+\.[0-9]+\.[0-9]+([-+][A-Za-z0-9.]+)?' \
    | head -n1)"
  [ -n "$OPENCLAW_VERSION" ] || OPENCLAW_VERSION="unknown"
fi

log "=== mirror run start (workspace=$WORKSPACE_DIR openclaw=$OPENCLAW_VERSION) ==="

mkdir -p "$SKILLS_DEST"

# Source roots, in priority order. Later sources cannot override earlier ones
# in the *same* run (first-source-wins per skill name); workspace user-authored
# always wins via the no-clobber check.
SOURCE_ROOTS=(
  "$NPM_ROOT/openclaw/skills"
  "$HOME/.openclaw/skills"
)

# Track which destination dirs the mirror touched/owns this run, for GC.
TOUCHED_FILE="$(mktemp -t openclaw-mirror-touched.XXXXXX)"
trap 'rm -f "$TOUCHED_FILE"' EXIT

# Compute a stable content fingerprint for a directory tree (sorted by path).
fingerprint_dir() {
  local dir="$1"
  ( cd "$dir" 2>/dev/null && \
    find . -type f ! -name '.openclaw-mirror' \
      | LC_ALL=C sort \
      | xargs -I{} shasum -a 256 "{}" 2>/dev/null \
      | shasum -a 256 \
      | awk '{print $1}'
  )
}

# Read the source path stored in a marker file. Empty if missing.
marker_source() {
  awk -F': *' '$1=="source"{print $2; exit}' "$1" 2>/dev/null
}

marker_fingerprint() {
  awk -F': *' '$1=="fingerprint"{print $2; exit}' "$1" 2>/dev/null
}

# Mirror one skill source dir into <SKILLS_DEST>/<name>.
mirror_skill() {
  local src="$1"
  local name
  name="$(basename "$src")"

  # Skip dotfiles or non-skill dirs.
  case "$name" in
    .*|node_modules) return 0 ;;
  esac
  if [ ! -f "$src/SKILL.md" ]; then
    vlog "skip $name: no SKILL.md in $src"
    return 0
  fi

  local dest="$SKILLS_DEST/$name"
  local marker="$dest/$MARKER_NAME"

  # If destination exists and is NOT marker-owned, leave it alone.
  if [ -e "$dest" ] && [ ! -f "$marker" ]; then
    vlog "skip $name: user-authored at $dest (no marker)"
    echo "$name" >> "$TOUCHED_FILE"
    return 0
  fi

  local src_fp
  src_fp="$(fingerprint_dir "$src")"
  if [ -z "$src_fp" ]; then
    log "skip $name: could not fingerprint $src"
    return 0
  fi

  if [ -f "$marker" ]; then
    local existing_fp
    existing_fp="$(marker_fingerprint "$marker")"
    if [ "$existing_fp" = "$src_fp" ]; then
      vlog "ok   $name: up to date"
      echo "$name" >> "$TOUCHED_FILE"
      return 0
    fi
    log "refresh $name: fingerprint changed ($existing_fp -> $src_fp)"
  else
    log "create  $name: mirroring from $src"
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    echo "$name" >> "$TOUCHED_FILE"
    return 0
  fi

  # rsync --delete keeps marker-owned dirs in lockstep with source contents.
  # We exclude the marker file itself from being clobbered by --delete (it
  # doesn't exist on the source anyway, but be explicit).
  mkdir -p "$dest"
  if ! rsync -a --delete --exclude="$MARKER_NAME" "$src/" "$dest/" 2>>"$LOG_FILE"; then
    log "ERROR rsync failed for $name; leaving destination in place"
    return 0
  fi

  cat > "$marker" <<EOF
source: $src
openclaw_version: $OPENCLAW_VERSION
fingerprint: $src_fp
mirrored_at: $(date -Iseconds)
EOF
  echo "$name" >> "$TOUCHED_FILE"
}

# Walk source roots and mirror each skill. First source wins per name.
seen_names_file="$(mktemp -t openclaw-mirror-seen.XXXXXX)"
trap 'rm -f "$TOUCHED_FILE" "$seen_names_file"' EXIT
for root in "${SOURCE_ROOTS[@]}"; do
  if [ ! -d "$root" ]; then
    vlog "no source root at $root (skipping)"
    continue
  fi
  for entry in "$root"/*/; do
    [ -d "$entry" ] || continue
    name="$(basename "$entry")"
    if grep -Fxq "$name" "$seen_names_file" 2>/dev/null; then
      vlog "skip $name: already considered from earlier source"
      continue
    fi
    echo "$name" >> "$seen_names_file"
    mirror_skill "${entry%/}"
  done
done

# Garbage collect: drop marker-owned dirs we did not touch this run
# (their source must have disappeared upstream).
if [ -d "$SKILLS_DEST" ]; then
  for entry in "$SKILLS_DEST"/*/; do
    [ -d "$entry" ] || continue
    name="$(basename "$entry")"
    marker="$entry$MARKER_NAME"
    [ -f "$marker" ] || continue
    if grep -Fxq "$name" "$TOUCHED_FILE" 2>/dev/null; then
      continue
    fi
    log "gc     $name: removing stale mirror at $entry (source $(marker_source "$marker") gone)"
    if [ "$DRY_RUN" -eq 0 ]; then
      rm -rf "$entry"
    fi
  done
fi

log "=== mirror run done ==="
exit 0
