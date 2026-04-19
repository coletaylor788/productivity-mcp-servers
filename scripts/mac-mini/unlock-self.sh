#!/bin/bash
# Mac Mini self-unlock: run on the Mini itself (over SSH) to drive its own
# loginwindow via localhost VNC. Reads the puddles account password from stdin.
#
# Use case: phone or laptop SSHes in after FV is unlocked, pipes the password,
# script connects to localhost::5900 via Apple ARD auth and types the password
# into loginwindow to start the GUI session.
#
# Requirements (on this Mac):
#   - python3 with vncdotool installed:
#       /usr/bin/python3 -m pip install --user vncdotool
#     (or use a venv at ~/.unlock-venv)
#   - Screen Sharing enabled in System Settings (allow puddles)
#
# Usage:
#   ssh puddles@mac 'unlock-self.sh' <<< "$ACCOUNT_PASSWORD"

set -u

# Read password: from stdin pipe if non-TTY, else prompt (no echo).
if [ -t 0 ]; then
  echo -n "puddles password: " >&2
  stty -echo
  IFS= read -r PW
  stty echo
  echo >&2
else
  IFS= read -r PW
fi
if [ -z "${PW:-}" ]; then
  echo "!! no password provided" >&2
  exit 2
fi

USER_NAME="puddles"
HOST="localhost"

# Bail early if GUI session is already up — nothing to do.
if [ "$(stat -f %Su /dev/console)" = "$USER_NAME" ]; then
  echo "GUI session already active for $USER_NAME — nothing to do."
  exit 0
fi

echo "→ Driving localhost VNC (Apple ARD auth + keystroke injection)..."

PW="$PW" USER_NAME="$USER_NAME" HOST="$HOST" /usr/bin/python3 <<'PY' 2>&1 \
  | grep -Ev "^$|PIL\.|twisted: (Starting|Stopping|Using|Offered|Native)"
import os, time, logging
logging.basicConfig(level=logging.INFO)
from vncdotool import api
client = api.connect(
    f"{os.environ['HOST']}::5900",
    username=os.environ['USER_NAME'],
    password=os.environ['PW'],
)
client.timeout = 30
time.sleep(8)                       # let loginwindow render and focus pw field
for ch in os.environ['PW']:
    client.keyPress(ch)
    time.sleep(0.08)
time.sleep(0.5)
client.keyPress('enter')
time.sleep(3)
client.disconnect()
print("VNC keystrokes sent", flush=True)
import os as _os
_os._exit(0)
PY

unset PW

echo "→ Waiting 10s for GUI session to start..."
sleep 10

CONSOLE=$(stat -f %Su /dev/console)
echo "console: $CONSOLE"
if [ "$CONSOLE" = "$USER_NAME" ]; then
  echo "✅ GUI session active"
  exit 0
else
  echo "!! GUI session did NOT start (console=$CONSOLE)"
  exit 1
fi
