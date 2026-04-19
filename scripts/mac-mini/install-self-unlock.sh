#!/bin/bash
# Run on the Mac Mini once: install vncdotool and place unlock-self.sh in /usr/local/bin.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC="$SCRIPT_DIR/unlock-self.sh"
DEST="/usr/local/bin/unlock-self.sh"

if [ ! -f "$SRC" ]; then
  echo "!! $SRC not found"
  exit 1
fi

echo "→ Installing vncdotool for /usr/bin/python3 (user site)..."
/usr/bin/python3 -m pip install --user --upgrade vncdotool

echo "→ Installing $DEST (sudo)..."
sudo install -m 0755 "$SRC" "$DEST"

echo "→ Verifying..."
"$DEST" </dev/null && echo "(expected non-zero — no stdin password)" || echo "Install complete: $DEST"
