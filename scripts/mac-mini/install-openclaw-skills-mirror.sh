#!/bin/bash
# One-time installer (run as the user who owns the OpenClaw workspace, e.g.
# `puddles` on the mini; sudo required for the script copy).
#
# - Installs mirror-openclaw-skills.sh to /usr/local/bin
# - Installs the LaunchAgent into ~/Library/LaunchAgents (per-user, since
#   ~/.openclaw and ~/.npm-global are user-scoped)
# - Bootstraps the agent into the user's launchd domain
# - Runs the mirror once synchronously so the workspace is populated before
#   the gateway hits its first prompt cycle

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SH_SRC="$SCRIPT_DIR/mirror-openclaw-skills.sh"
SH_DEST="/usr/local/bin/mirror-openclaw-skills.sh"
PLIST_SRC="$SCRIPT_DIR/ai.openclaw.skills-mirror.plist"
PLIST_NAME="ai.openclaw.skills-mirror.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME"

[ -f "$SH_SRC" ]    || { echo "!! $SH_SRC not found"; exit 1; }
[ -f "$PLIST_SRC" ] || { echo "!! $PLIST_SRC not found"; exit 1; }

if [ "${USER:-}" != "puddles" ]; then
  echo "⚠️  Expected to run as 'puddles' (currently '$USER')."
  echo "   The plist hardcodes /Users/puddles paths; continuing anyway."
fi

echo "→ Installing $SH_DEST..."
sudo install -m 0755 "$SH_SRC" "$SH_DEST"

echo "→ Installing LaunchAgent at $PLIST_DEST..."
mkdir -p "$HOME/Library/LaunchAgents"
install -m 0644 "$PLIST_SRC" "$PLIST_DEST"

echo "→ Running mirror once synchronously to populate workspace..."
"$SH_DEST"

echo "→ Bootstrap LaunchAgent into gui/$(id -u)..."
launchctl bootout "gui/$(id -u)" "$PLIST_DEST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST"

echo "→ Verifying..."
if launchctl print "gui/$(id -u)/ai.openclaw.skills-mirror" >/dev/null 2>&1; then
  echo "✅ Installed. Logs: ~/.openclaw/logs/skills-mirror.log"
  echo "   Inspect status: launchctl print gui/\$(id -u)/ai.openclaw.skills-mirror | head"
else
  echo "!! agent not loaded"
  exit 1
fi
