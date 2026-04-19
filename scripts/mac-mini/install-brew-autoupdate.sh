#!/bin/bash
# One-time installer (run as cole, sudo required):
# - Copies brew-autoupdate.sh to /usr/local/bin
# - Installs the LaunchDaemon to /Library/LaunchDaemons (runs system-wide as cole)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SH_SRC="$SCRIPT_DIR/brew-autoupdate.sh"
SH_DEST="/usr/local/bin/brew-autoupdate.sh"
PLIST_SRC="$SCRIPT_DIR/com.cole.brew-autoupdate.plist"
PLIST_DEST="/Library/LaunchDaemons/com.cole.brew-autoupdate.plist"

[ -f "$SH_SRC" ]    || { echo "!! $SH_SRC not found"; exit 1; }
[ -f "$PLIST_SRC" ] || { echo "!! $PLIST_SRC not found"; exit 1; }

echo "→ Installing $SH_DEST..."
sudo install -m 0755 "$SH_SRC" "$SH_DEST"

echo "→ Installing LaunchDaemon at $PLIST_DEST..."
sudo install -m 0644 -o root -g wheel "$PLIST_SRC" "$PLIST_DEST"

echo "→ Bootstrap LaunchDaemon..."
sudo launchctl bootout system "$PLIST_DEST" 2>/dev/null || true
sudo launchctl bootstrap system "$PLIST_DEST"

echo "→ Verifying..."
sudo launchctl list | grep com.cole.brew-autoupdate || { echo "!! daemon not loaded"; exit 1; }
echo "✅ Installed. Next run: Sunday 03:00 local. Logs at /Users/cole/Library/Logs/brew-autoupdate*.log"
