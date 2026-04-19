#!/bin/bash
# Mac Mini remote unlock: SSH FileVault unlock + Apple-ARD VNC login at loginwindow.
#
# Background:
#   On Apple Silicon Macs with FileVault enabled, a reboot leaves the machine
#   in two locked states:
#     1. FV pre-boot: disk is encrypted, no sshd-proper, only a stub SSH that
#        accepts a secure-token user's password to unlock the disk.
#     2. loginwindow: disk unlocked, full sshd up, but NO GUI session — services
#        running per-user (LaunchAgents) are not loaded until someone logs in.
#
#   Apple does not allow programmatic GUI login from a normal SSH session
#   (sandbox boundary; LoginHook removed; `launchctl asuser` requires an
#   existing session). The only remote path that works is a VNC client
#   driving the loginwindow password field.
#
# How this script works:
#   Step 1 — SSH the FV pre-boot stub with the puddles account password to
#            unlock the disk. expect handles the prompt; password never echoes
#            and is never written to disk.
#   Step 2 — Wait for boot to reach loginwindow (~45s on M4).
#   Step 3 — Connect via VNC using Apple ARD authentication (Diffie-Hellman
#            scheme 30, requires username + password), then inject keystrokes
#            (password + enter) into the loginwindow password field. ARD auth
#            avoids needing a separate "VNC viewers may control screen with
#            password" entry.
#
# Requirements (on the runner machine):
#   - expect (preinstalled on macOS)
#   - /usr/bin/python3 with vncdotool installed:
#       /usr/bin/python3 -m pip install --user vncdotool
#   - SSH reachability to $HOST on port 22
#   - VNC reachability to $HOST on port 5900
#
# On the Mac Mini, Screen Sharing must be enabled for the puddles user
# (System Settings → General → Sharing → Screen Sharing → Allow access for:
# specific users → puddles). No separate VNC password is required.

set -u
HOST="192.168.8.230"
USER="puddles"

echo -n "Enter $USER account password: "
stty -echo
IFS= read -r PW
stty echo
echo

echo "→ Step 1: SSH FileVault unlock..."
expect <<EOF
log_user 0
set timeout 30
spawn ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 $USER@$HOST true
expect {
  -re "(?i)password"           { send -- "$PW\r"; puts "  (password sent)"; exp_continue }
  -re "(yes/no)"               { send "yes\r"; exp_continue }
  -re "successfully unlocked"  { puts "  -> 'successfully unlocked' seen"; exp_continue }
  -re "denied|incorrect|failed" { puts "  !! FV unlock REJECTED"; exit 1 }
  -re "Permission denied"      { puts "  !! Permission denied"; exit 1 }
  timeout                      { puts "  !! TIMEOUT"; exit 1 }
  eof                          { puts "  -> connection closed" }
}
EOF
RC=$?
if [ $RC -ne 0 ]; then
  echo "→ FV unlock FAILED (rc=$RC). Aborting."
  unset PW
  exit 1
fi
echo "→ FV unlock issued"

echo "→ Waiting 45s for boot to reach loginwindow..."
sleep 45

echo "→ Step 2: VNC Apple-ARD auth + keystroke injection at loginwindow..."
PW="$PW" USER="$USER" HOST="$HOST" /usr/bin/python3 <<'PY' 2>&1 | grep -Ev "^$|PIL\.|twisted: (Starting|Stopping|Using|Offered|Native)"
import os, time, logging
logging.basicConfig(level=logging.INFO)
from vncdotool import api
client = api.connect(
    f"{os.environ['HOST']}::5900",
    username=os.environ['USER'],
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
_os._exit(0)                        # work around twisted reactor hang
PY

echo "→ Waiting 15s for GUI session to fully start..."
sleep 15

echo "→ Verifying GUI session..."
ssh -o StrictHostKeyChecking=no -o ConnectTimeout=5 $USER@$HOST \
  'echo "console: $(stat -f %Su /dev/console)"; echo "who:"; who; launchctl print gui/$(id -u) 2>&1 | head -2'

unset PW
