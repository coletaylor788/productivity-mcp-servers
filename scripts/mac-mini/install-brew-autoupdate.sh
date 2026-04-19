#!/bin/bash
# One-time installer: places the brew-autoupdate script + LaunchAgent on the Mac Mini.
# Run AS PUDDLES (LaunchAgent lives in puddles' home). The script copy to /usr/local/bin
# requires sudo; if you don't have sudo as puddles, run that line manually as cole.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SH_SRC="$SCRIPT_DIR/brew-autoupdate.sh"
SH_DEST="/usr/local/bin/brew-autoupdate.sh"
PLIST_SRC="$SCRIPT_DIR/com.cole.brew-autoupdate.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.cole.brew-autoupdate.plist"

[ -f "$SH_SRC" ]    || { echo "!! $SH_SRC not found"; exit 1; }
[ -f "$PLIST_SRC" ] || { echo "!! $PLIST_SRC not found"; exit 1; }

echo "→ Installing $SH_DEST..."
if [ -w /usr/local/bin ] && [ -w "$SH_DEST" 2>/dev/null -o ! -e "$SH_DEST" ]; then
  install -m 0755 "$SH_SRC" "$SH_DEST"
else
  sudo install -m 0755 "$SH_SRC" "$SH_DEST"
fi

echo "→ Installing LaunchAgent at $PLIST_DEST..."
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
install -m 0644 "$PLIST_SRC" "$PLIST_DEST"

echo "→ Loading LaunchAgent..."
launchctl unload "$PLIST_DEST" 2>/dev/null || true
launchctl load   "$PLIST_DEST"

echo "→ Verifying..."
launchctl list | grep com.cole.brew-autoupdate || { echo "!! agent not loaded"; exit 1; }
echo "✅ Installed. Next run: Sunday 03:00 local. Logs at ~/Library/Logs/brew-autoupdate*.log"
