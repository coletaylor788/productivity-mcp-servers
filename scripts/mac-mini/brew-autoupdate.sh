#!/bin/bash
# Weekly Homebrew update for puddles. Logs to ~/Library/Logs/brew-autoupdate.log.
# Invoked by ~/Library/LaunchAgents/com.cole.brew-autoupdate.plist.

set -u
exec >> "$HOME/Library/Logs/brew-autoupdate.log" 2>&1

echo
echo "=== brew-autoupdate run @ $(date -Iseconds) ==="

export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v brew >/dev/null 2>&1; then
  echo "!! brew not found on PATH"
  exit 1
fi

brew update
brew upgrade
brew cleanup --prune=all
echo "=== done @ $(date -Iseconds) ==="
