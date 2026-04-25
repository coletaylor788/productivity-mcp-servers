# Talking to Puddles on iMessage

This is the second guide in my journey building Puddles, my personal AI agent, on a Mac Mini. Guide 01 ended with a hardened, headless box on Tailscale. This one wires that box to iMessage so I can text my agent like he's a person — and makes the whole thing self-healing so it survives the four hours I'm not paying attention to it.

By the end of it you'll have:

- An **iMessage bridge** running on the Mini that turns texts into HTTP webhooks
- An **OpenClaw channel** that picks those webhooks up and routes them to the agent
- A **DM allowlist** so only you (and people you explicitly add) can reach Puddles this way
- A **system LaunchDaemon** running the gateway as the `puddles` user — survives logouts, respawns on crash
- A **15-minute self-heal loop** that catches the common failure modes and fixes them without you ever knowing

Heads-up: this guide assumes you've finished guide 01. If you haven't, none of the LaunchDaemon stuff makes sense and the `puddles` user won't exist.

> **Time:** about an hour, most of it the BlueBubbles permission dance.
> **Skill:** comfortable with launchd, sqlite, and bash.

---

## Table of contents

1. [Why iMessage](#1-why-imessage)
2. [How it all fits together](#2-how-it-all-fits-together)
3. [Installing BlueBubbles](#3-installing-bluebubbles)
4. [Wiring BlueBubbles to OpenClaw](#4-wiring-bluebubbles-to-openclaw)
5. [DM allowlist — who can text the agent](#5-dm-allowlist--who-can-text-the-agent)
6. [Making the gateway survive everything](#6-making-the-gateway-survive-everything)
7. [Self-healing scripts](#7-self-healing-scripts)
8. [Wiring the self-heal into launchd](#8-wiring-the-self-heal-into-launchd)
9. [Verifying everything works](#9-verifying-everything-works)
10. [Where to go next](#10-where-to-go-next)
11. [Appendix: gotchas worth re-reading](#11-appendix-gotchas-worth-re-reading)

---

## 1. Why iMessage

I want to text my agent and have him answer. Like a person. Not Slack, not a webapp, not "open the dashboard."

A few reasons iMessage is the right channel for a personal agent:

- **It's where I already live.** Texting is the lowest-friction interface my brain has. If I have to remember to open a separate app to talk to Puddles, I won't.
- **It works on every device I own.** iPhone, MacBook, iPad, Apple Watch. Same thread, same history, no syncing to think about.
- **It's end-to-end encrypted.** The transport between me and the Mini is Apple's, not some startup's. The agent's replies go through the same pipe.
- **Family and friends already use it.** Eventually I want Puddles to be reachable by people who aren't me — my parents, my partner — and they're not going to install some app. They already have Messages.

The tradeoff is that I have to run a Mac with a real Apple ID logged in (we already have that — `puddles` from guide 01) and a bridge process that translates between Apple's binary protocol and HTTP. That bridge is BlueBubbles.

---

## 2. How it all fits together

```
   ┌──────────┐                                    ┌──────────────┐
   │  iPhone  │ ──── iMessage (Apple's E2EE) ────► │   Mac Mini   │
   └──────────┘                                    │  Messages.app│
                                                   └──────┬───────┘
                                                          │ local IPC
                                                          ▼
                                                   ┌──────────────┐
                                                   │ BlueBubbles  │
                                                   │   (:1234)    │
                                                   └──────┬───────┘
                                                          │ HTTP POST
                                                          │ /bluebubbles-webhook
                                                          ▼
                                                   ┌──────────────┐
                                                   │  OpenClaw    │
                                                   │   gateway    │
                                                   │   (:18789)   │
                                                   └──────┬───────┘
                                                          │
                                                          ▼
                                                   ┌──────────────┐
                                                   │    Agent     │
                                                   │  (the model) │
                                                   └──────┬───────┘
                                                          │
                          reply travels back the same path, in reverse
```

Two things to notice:

- **Everything is on `127.0.0.1`.** BlueBubbles listens on `1234`, the gateway on `18789`. Nothing on this hop is exposed to the LAN, let alone the internet. The Tailscale ACLs from guide 01 already block inbound LAN traffic; this layer wouldn't even be reachable if it tried.
- **Messages.app has to actually be running in `puddles`' GUI session.** This is the reason the §11/§12 unlock dance from guide 01 exists. If you only do the pre-login SSH FileVault unlock and skip the GUI login, Messages.app never starts and BlueBubbles has nothing to bridge.

[BlueBubbles](https://bluebubbles.app/) is the open-source server side; we don't need its mobile client because OpenClaw is the only consumer.

---

## 3. Installing BlueBubbles

As **puddles**, via SSH:

```bash
brew install --cask bluebubbles
```

That puts `BlueBubbles.app` in `/Applications`. Now the part you can't do over SSH: granting permissions.

### Permissions you have to grant via the GUI

BlueBubbles needs a handful of TCC entitlements that macOS only lets you approve via a real GUI prompt. You can't `sudo tccutil` your way past these — the prompts are signed by `tccd` and clicking "OK" requires a real session.

VNC into the Mini as `puddles` (use guide 01 §11 or §12 if you've rebooted). Then open **System Settings → Privacy & Security** and add `BlueBubbles.app` to:

- ✅ **Full Disk Access** — needed to read the `chat.db` Messages stores under `~/Library/Messages/`
- ✅ **Accessibility** — needed for the Private API helper to drive Messages.app
- ✅ **Automation → Messages** (this one shows up after BlueBubbles asks for it the first time you launch it)

Now launch BlueBubbles from the Dock or Spotlight. First-launch flow:

1. Walk through the setup wizard. Sign in with the same Apple ID that's signed into Messages.
2. **Set a strong API password.** Generate one in your password manager. This password authenticates every HTTP call into BlueBubbles, including OpenClaw's. Save it somewhere you can read it from a script later — we'll be putting it in `~/.openclaw/secrets.json`.
3. Find the **Private API** section in the settings and turn it on. Without this, you don't get typing indicators, read receipts, or tapbacks back from the agent — Puddles can still reply, but the experience feels lifeless. The Private API uses an injected helper bundle that BlueBubbles installs into Messages.app for you. There's a one-click installer in the BlueBubbles UI.
4. Make sure the API server is set to listen on `127.0.0.1:1234`. Default is fine; just verify it isn't bound to `0.0.0.0`.

### Auto-start on login

In BlueBubbles' settings, enable **"Launch at startup."** After every reboot + GUI login, BlueBubbles needs to come up on its own.

While you're at it, in **System Settings → General → Login Items**, double-check that `BlueBubbles` is in the list under "Open at Login." The cask's auto-start toggle just adds the same entry, but I trust the System Settings view more.

### Why a separate API password instead of TLS

This is one of those decisions where the obvious "more secure" answer is wrong. BlueBubbles supports an HTTPS mode with a self-signed cert, but the only consumer on this box is the OpenClaw gateway, which lives in the same loopback interface. TLS on `127.0.0.1` buys nothing — there's no MITM surface — and it adds a cert-rotation headache I'd rather not own. The API password is what actually gates access, and it lives in `~/.openclaw/secrets.json` (mode `0600`, owned by `puddles`).

---

## 4. Wiring BlueBubbles to OpenClaw

OpenClaw has a `channels add` subcommand that does three things in one shot: registers the channel with the gateway, writes the password to `~/.openclaw/secrets.json`, and POSTs the webhook URL into BlueBubbles' own config.

```bash
openclaw channels add --channel bluebubbles \
  --http-url http://127.0.0.1:1234 \
  --password "PASSWORD_FROM_BLUEBUBBLES" \
  --webhook-path /bluebubbles-webhook
```

Under the covers BlueBubbles writes that webhook URL into a sqlite database at:

```
~/Library/Application Support/bluebubbles-server/config.db
```

…specifically a `webhook` table. Remember that path — the self-heal script in §7 reaches into it directly.

### Quick sanity check

```bash
# Authenticated ping into BlueBubbles
PW=$(jq -r .providers.bluebubbles.apiKey ~/.openclaw/secrets.json)
curl -s "http://127.0.0.1:1234/api/v1/ping?password=$PW"
# → {"status":200,"message":"pong","data":null}

# Webhook URL stored in BB
sqlite3 ~/Library/Application\ Support/bluebubbles-server/config.db \
  "SELECT url FROM webhook;"
# → http://127.0.0.1:18789/bluebubbles-webhook?password=...
```

If both of those work, send yourself a text from a different device. The gateway log (`~/.openclaw/logs/gateway.log`) should show an `embedded run start … messageChannel=bluebubbles` line within a couple of seconds.

---

## 5. DM allowlist — who can text the agent

By default, anyone who sends a text to the Apple ID logged into Messages on the Mini can talk to your agent. That's an open invitation for spam, scam SMS, and group chat noise. Lock it down before anything else.

```bash
openclaw config set channels.bluebubbles.dmPolicy allowlist
openclaw config set 'channels.bluebubbles.allowFrom' '["+1COLE_PHONE"]'
```

Replace `+1COLE_PHONE` with your number in `+E.164` format. Anything from a sender not in `allowFrom` is dropped at the gateway — the agent never sees the message and BlueBubbles isn't asked to render any reply.

For MVP that list has exactly one entry: me. Onboarding family and friends is a Phase 8 problem (think: per-sender tool allowlists, conversation-scoped memory, identity-aware policies). I'll cover that in a later guide. For now, allowlist of one.

---

## 6. Making the gateway survive everything

The OpenClaw gateway started its life as a per-user LaunchAgent at `~/Library/LaunchAgents/ai.openclaw.gateway.plist`. That works fine for ten minutes of testing and falls over the moment something — a `launchctl bootout`, a logout, an OS update — boots the user session. For a server I expect to run for months, "tied to whether the user is logged in" is the wrong shape.

So the gateway runs as a **system LaunchDaemon** (in `/Library/LaunchDaemons/`), under the `puddles` user, with `KeepAlive` so launchd respawns it on crash.

Why a system daemon running as a non-admin user is the right answer:

- **Survives logout.** A LaunchDaemon's lifecycle isn't tied to any user session.
- **Can't be killed by your own user-session `launchctl`.** If I'm SSH'd in as `puddles` and accidentally `launchctl bootout` something, my user-domain commands can't touch the system domain.
- **`KeepAlive` actually fires.** In the user domain, KeepAlive only respawns while the session is active. In the system domain, it respawns whenever the process dies, period.
- **Still runs as `puddles`, not root.** Compromise of the gateway gives you the same blast radius as compromise of the agent — one user account, no sudo. (See guide 01 §2.)

### The plist

`/Library/LaunchDaemons/ai.openclaw.gateway.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.openclaw.gateway</string>

    <key>UserName</key>
    <string>puddles</string>
    <key>GroupName</key>
    <string>staff</string>

    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/node</string>
        <string>/Users/puddles/git/openclaw/dist/index.js</string>
        <string>gateway</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>/Users/puddles</string>
        <key>USER</key>
        <string>puddles</string>
        <key>LOGNAME</key>
        <string>puddles</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>

    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>

    <key>StandardOutPath</key>
    <string>/Users/puddles/.openclaw/logs/gateway.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/puddles/.openclaw/logs/gateway.err.log</string>
</dict>
</plist>
```

Two settings worth calling out:

- **`KeepAlive=true`** — respawn unconditionally when the process exits. We want crashes to heal themselves.
- **`ThrottleInterval=5`** — don't respawn faster than once every 5 seconds. Without this, a process that dies on startup (bad config, port already taken) becomes a CPU-melting respawn loop.

### Install

System LaunchDaemons must be owned by `root:wheel`, mode `0644`. The `install(1)` command does the chmod/chown in one shot:

```bash
# As cole (admin), via SSH
sudo install -o root -g wheel -m 644 \
  /Users/puddles/git/puddles/scripts/mac-mini/ai.openclaw.gateway.plist \
  /Library/LaunchDaemons/ai.openclaw.gateway.plist

# Bootstrap into launchd's system domain
sudo launchctl bootstrap system /Library/LaunchDaemons/ai.openclaw.gateway.plist
sudo launchctl enable system/ai.openclaw.gateway
```

Verify:

```bash
sudo launchctl list | grep openclaw
# → -    0    ai.openclaw.gateway
# (PID may be present; exit status 0 means last invocation was clean)

curl -s http://127.0.0.1:18789/healthz
# → {"ok":true}
```

If you previously had the per-user LaunchAgent installed, remove it first or you'll have two gateways racing for the port:

```bash
launchctl bootout gui/$(id -u)/ai.openclaw.gateway 2>/dev/null
rm -f ~/Library/LaunchAgents/ai.openclaw.gateway.plist
```

---

## 7. Self-healing scripts

The LaunchDaemon handles "process crashed." The actual failure modes I see in practice are subtler:

- BlueBubbles is running, but its port has stopped accepting connections.
- BlueBubbles' webhook URL gets edited (or wiped) by something well-meaning, and the password param disappears — every webhook hits the gateway as unauthenticated.
- A run starts on the BB channel and never finishes — some downstream tool is hanging and the agent is wedged.
- The gateway's `/healthz` is returning 200 but nothing's actually getting routed because the run loop is dead.

None of these are a process-died event, so launchd's KeepAlive doesn't help. I needed something that periodically asks "is this thing actually working" and pokes the right spot when the answer is no.

The setup is three scripts in `~/.openclaw/bin/` plus one launchd timer. Inspired by the [BlueBubbles health guide](https://lobster.shahine.com/guides/bluebubbles-health/) — the lobster scripts aren't public, so these are re-derived from the BlueBubbles docs.

### `bb-healthcheck.sh` — read-only

This is the diagnostic. It runs eight checks and exits non-zero if any fail. It never mutates state. Safe to run from anywhere, anytime.

```bash
#!/bin/bash
# Read-only health check for BlueBubbles ↔ OpenClaw integration.
# Exit 0 = all healthy, 1 = problem detected (caller should run bb-selfheal.sh).

set -u
BB_HOST="${BB_HOST:-127.0.0.1}"
BB_PORT="${BB_PORT:-1234}"
GATEWAY_HOST="${GATEWAY_HOST:-127.0.0.1}"
GATEWAY_PORT="${GATEWAY_PORT:-18789}"
GATEWAY_LOG="${GATEWAY_LOG:-$HOME/.openclaw/logs/gateway.log}"
SECRETS="${SECRETS:-$HOME/.openclaw/secrets.json}"
CONFIG_DB="${CONFIG_DB:-$HOME/Library/Application Support/bluebubbles-server/config.db}"
WATCHDOG="${WATCHDOG:-$HOME/.openclaw/bin/stuck-session-watchdog.sh}"

problems=0
warn() { echo "FAIL: $*"; problems=$((problems + 1)); }
ok()   { echo "OK:   $*"; }

# 1. BB process alive
if pgrep -x BlueBubbles >/dev/null; then
  ok "BlueBubbles process running"
else
  warn "BlueBubbles process not running"
fi

# 2. BB port listening
if /usr/sbin/lsof -nP -iTCP:"$BB_PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  ok "BlueBubbles port $BB_PORT listening"
else
  warn "BlueBubbles port $BB_PORT not listening"
fi

# 3. BB API responds (with auth)
if [ -r "$SECRETS" ]; then
  PW=$(/usr/bin/python3 -c "import json,sys; print(json.load(open('$SECRETS'))['providers']['bluebubbles']['apiKey'])" 2>/dev/null || true)
else
  PW=""
fi

if [ -n "$PW" ]; then
  code=$(/usr/bin/curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://$BB_HOST:$BB_PORT/api/v1/ping?password=$PW" || echo "000")
  if [ "$code" = "200" ]; then
    ok "BlueBubbles API ping ($code)"
  else
    warn "BlueBubbles API ping HTTP $code"
  fi
else
  warn "Cannot read BB password from $SECRETS — skipping authed ping"
fi

# 4. Messages.app AppleScript bridge (5s timeout) — informational only.
# BB Private API uses an injected helper bundle, not AppleScript, so iMessage
# can be fully working even when this hangs. Don't count as a failure.
if /bin/bash -c '( /usr/bin/perl -e "alarm shift; exec @ARGV" 5 /usr/bin/osascript -e '\''tell application "Messages" to count of services'\'' ) >/dev/null 2>&1' 2>/dev/null; then
  ok "Messages.app AppleScript bridge responsive"
else
  echo "INFO: Messages.app AppleScript bridge unresponsive (not required for BB Private API)"
fi

# 5. Gateway up
gcode=$(/usr/bin/curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://$GATEWAY_HOST:$GATEWAY_PORT/healthz" || echo "000")
if [ "$gcode" = "200" ]; then
  ok "OpenClaw gateway healthz ($gcode)"
else
  warn "OpenClaw gateway healthz HTTP $gcode"
fi

# 6. Webhook URL has password in BB config.db
if [ -r "$CONFIG_DB" ]; then
  url=$(/usr/bin/sqlite3 "$CONFIG_DB" "SELECT url FROM webhook LIMIT 1;" 2>/dev/null || true)
  if [ -z "$url" ]; then
    warn "No webhook configured in BlueBubbles config.db"
  elif echo "$url" | grep -q 'password='; then
    ok "Webhook URL contains password param"
  else
    warn "Webhook URL missing password param: $url"
  fi
else
  warn "Cannot read BB config.db at $CONFIG_DB"
fi

# 7. Recent webhook auth rejections in gateway log
if [ -r "$GATEWAY_LOG" ]; then
  rejects=$(/usr/bin/tail -n 2000 "$GATEWAY_LOG" | grep -cE 'webhook rejected.*unauthor' || true)
  if [ "$rejects" -gt 0 ]; then
    warn "Gateway log shows $rejects recent webhook auth rejections"
  else
    ok "No recent webhook auth rejections in gateway log"
  fi
fi

# 8. Stuck-session watchdog
if [ -x "$WATCHDOG" ]; then
  if "$WATCHDOG" 180 >/dev/null 2>&1; then
    ok "No stuck BlueBubbles runs detected"
  else
    warn "Stuck BlueBubbles run(s) detected (run watchdog manually for detail)"
  fi
fi

echo
if [ "$problems" -eq 0 ]; then
  echo "RESULT: HEALTHY"
  exit 0
else
  echo "RESULT: $problems problem(s) detected"
  exit 1
fi
```

A few things worth pointing out:

- **macOS doesn't ship `timeout(1)`.** That's why check #4 uses the `perl -e 'alarm shift; exec @ARGV' 5 …` trick — `alarm()` is in core Perl and Perl is always present. When the perl child gets killed by SIGALRM, bash prints a noisy `Alarm clock` job-status line; wrapping the whole thing in `bash -c '…' 2>/dev/null` swallows it. It looks ugly but it's portable to every Mac you'll touch.
- **The Messages.app AppleScript check is informational only.** I chased the wrong thing for a while assuming "AppleScript hang = iMessage broken." It isn't. BlueBubbles' Private API talks to Messages.app via an injected helper bundle, not AppleScript, so the bridge can be working perfectly while AppleScript is unresponsive. Keep the check for diagnostic context, but never let it gate a restart.

### `stuck-session-watchdog.sh` — read-only

The healthcheck calls this. It scans the last five `embedded run start … messageChannel=bluebubbles` lines in the gateway log and flags any that don't have a matching end/done/finish entry within `MAX_AGE` seconds (default 180, matching the agent timeout).

```bash
#!/bin/bash
# Detects BlueBubbles agent runs that started but never completed.
# Returns 0 if no stuck runs, 1 if stuck run(s) detected.

set -u
MAX_AGE="${1:-180}"   # seconds (matches agents.defaults.timeoutSeconds=180)
LOG="${OPENCLAW_LOG:-$HOME/.openclaw/logs/gateway.log}"

[ -f "$LOG" ] || { echo "ERROR: log not found: $LOG"; exit 1; }

now=$(date +%s)
stuck=0
total=0

# Look at the last 5 BB-channel run starts
while IFS= read -r line; do
  total=$((total + 1))
  ts=$(echo "$line" | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}' | head -1)
  rid=$(echo "$line" | grep -oE 'runId=[a-f0-9-]+' | head -1 | cut -d= -f2)
  [ -z "$rid" ] && continue
  start_epoch=$(date -j -f "%Y-%m-%dT%H:%M:%S" "$ts" +%s 2>/dev/null) || continue
  age=$((now - start_epoch))
  # Skip runs >1h old (probably log truncation/old)
  [ "$age" -gt 3600 ] && continue
  # Look for matching end/done/finish/error after the start line
  end=$(grep -E "(embedded run (end|done|finish)|run completed|run cleared).*runId=$rid" "$LOG" | head -1)
  if [ -z "$end" ] && [ "$age" -gt "$MAX_AGE" ]; then
    echo "STUCK: runId=$rid age=${age}s (max ${MAX_AGE}s)"
    stuck=$((stuck + 1))
  fi
done < <(grep -E "embedded run start.*messageChannel=bluebubbles" "$LOG" | tail -5)

if [ "$stuck" -gt 0 ]; then
  echo "STATUS: STUCK ($stuck stuck run(s) detected)"
  echo "ACTION: Gateway restart recommended"
  exit 1
else
  echo "STATUS: OK ($total recent BB run(s) checked, none stuck)"
  exit 0
fi
```

The `> 3600` clause is there so that runs from an hour ago (i.e. probably half-rotated out of the log) don't get treated as "stuck just now." Pure noise reduction.

### `bb-selfheal.sh` — the one that mutates state

This is the only script in the set that's allowed to change anything. The pattern is: run the healthcheck, do nothing if everything's fine, otherwise apply the smallest fix that addresses each failure, then re-run the healthcheck.

```bash
#!/bin/bash
# Self-healing for BlueBubbles ↔ OpenClaw integration.
# Runs healthcheck, applies fixes for common failure modes, re-runs check.
# Designed to be safe to invoke every 15 min from launchd.

set -u
BB_HOST="${BB_HOST:-127.0.0.1}"
BB_PORT="${BB_PORT:-1234}"
GATEWAY_HOST="${GATEWAY_HOST:-127.0.0.1}"
GATEWAY_PORT="${GATEWAY_PORT:-18789}"
GATEWAY_LOG="${GATEWAY_LOG:-$HOME/.openclaw/logs/gateway.log}"
SECRETS="${SECRETS:-$HOME/.openclaw/secrets.json}"
CONFIG_DB="${CONFIG_DB:-$HOME/Library/Application Support/bluebubbles-server/config.db}"
WEBHOOK_PATH="${WEBHOOK_PATH:-/bluebubbles-webhook}"
HEALTHCHECK="${HEALTHCHECK:-$HOME/.openclaw/bin/bb-healthcheck.sh}"
WATCHDOG="${WATCHDOG:-$HOME/.openclaw/bin/stuck-session-watchdog.sh}"
LOCK="/tmp/bb-selfheal.lock"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*"; }

# Single-instance lock
exec 9>"$LOCK"
if ! /usr/bin/flock -n 9 2>/dev/null; then
  # macOS lacks flock; fall back to PID file check
  :
fi

log "=== bb-selfheal start ==="

# Read BB password
PW=""
if [ -r "$SECRETS" ]; then
  PW=$(/usr/bin/python3 -c "import json,sys; print(json.load(open('$SECRETS'))['providers']['bluebubbles']['apiKey'])" 2>/dev/null || true)
fi

# 1. Initial check
if "$HEALTHCHECK" >/dev/null 2>&1; then
  log "Initial healthcheck PASSED — nothing to do"
  exit 0
fi
log "Initial healthcheck FAILED — attempting fixes"

# 2. Restart BlueBubbles if process dead OR port not listening
needs_bb_restart=0
pgrep -x BlueBubbles >/dev/null || needs_bb_restart=1
/usr/sbin/lsof -nP -iTCP:"$BB_PORT" -sTCP:LISTEN >/dev/null 2>&1 || needs_bb_restart=1

if [ "$needs_bb_restart" = "1" ]; then
  log "Restarting BlueBubbles.app"
  # Try clean quit first
  /usr/bin/osascript -e 'tell application "BlueBubbles" to quit' >/dev/null 2>&1 || true
  sleep 3
  # Force-kill any survivors
  pid=$(pgrep -x BlueBubbles | head -1 || true)
  [ -n "$pid" ] && kill "$pid" 2>/dev/null || true
  sleep 2
  /usr/bin/open -a BlueBubbles >/dev/null 2>&1 || log "WARN: open -a BlueBubbles failed (Gatekeeper?)"
  sleep 8
fi

# 3. (skipped) Messages.app AppleScript bridge restart — was a false-positive
# trigger; BB Private API uses an injected helper bundle, not AppleScript.

# 4. Repair webhook URL in BB config.db if missing password
if [ -w "$CONFIG_DB" ] && [ -n "$PW" ]; then
  url=$(/usr/bin/sqlite3 "$CONFIG_DB" "SELECT url FROM webhook LIMIT 1;" 2>/dev/null || true)
  expected="http://$GATEWAY_HOST:$GATEWAY_PORT$WEBHOOK_PATH?password=$PW"
  if [ -z "$url" ]; then
    log "WARN: no webhook row in config.db — manual setup needed"
  elif [ "$url" != "$expected" ]; then
    log "Webhook URL drift; updating to expected value"
    /usr/bin/sqlite3 "$CONFIG_DB" "UPDATE webhook SET url='$expected' WHERE id=(SELECT id FROM webhook LIMIT 1);" || log "WARN: sqlite update failed"
  fi
fi

# 5. Restart gateway if healthz failing OR stuck-session detected
gcode=$(/usr/bin/curl -s -o /dev/null -w "%{http_code}" --max-time 3 "http://$GATEWAY_HOST:$GATEWAY_PORT/healthz" || echo "000")
needs_gw_restart=0
[ "$gcode" != "200" ] && needs_gw_restart=1
if [ -x "$WATCHDOG" ] && ! "$WATCHDOG" 180 >/dev/null 2>&1; then
  log "Stuck-session watchdog tripped"
  needs_gw_restart=1
fi

if [ "$needs_gw_restart" = "1" ]; then
  log "Restarting OpenClaw gateway (kill -> launchd respawn via KeepAlive)"
  gpid=$(pgrep -f 'openclaw/dist/index.js gateway' | head -1 || true)
  if [ -n "$gpid" ]; then
    kill "$gpid" 2>/dev/null || true
    log "  killed pid $gpid"
  else
    log "  WARN: no gateway process found"
  fi
  # KeepAlive=true + ThrottleInterval=5 means it respawns within ~5s
  sleep 8
fi

# 6. Final check
if "$HEALTHCHECK" >/dev/null 2>&1; then
  log "Post-fix healthcheck PASSED"
  log "=== bb-selfheal done (healed) ==="
  exit 0
else
  log "Post-fix healthcheck STILL FAILING — manual intervention may be needed"
  "$HEALTHCHECK" || true
  log "=== bb-selfheal done (degraded) ==="
  exit 1
fi
```

The bit I want to highlight: the gateway "restart" is a `kill`. We don't `launchctl kickstart` and we don't `launchctl bootout && bootstrap`. We send SIGTERM to the gateway pid and let the LaunchDaemon's `KeepAlive=true` plus `ThrottleInterval=5` bring it back up about five seconds later. This is the simplest possible mechanism, has one moving part, and matches the failure semantics of "the process crashed on its own" — exactly what `KeepAlive` is designed for.

Same idea for BlueBubbles: try a clean `osascript … quit` first, then fall back to `kill`, then `open -a BlueBubbles`. The launch-at-login setting handles all the system-startup paths; this just covers the post-startup recovery case.

### Install the scripts

```bash
# As puddles
mkdir -p ~/.openclaw/bin ~/.openclaw/logs/bb-health
cp /path/to/bb-healthcheck.sh        ~/.openclaw/bin/
cp /path/to/bb-selfheal.sh           ~/.openclaw/bin/
cp /path/to/stuck-session-watchdog.sh ~/.openclaw/bin/
chmod +x ~/.openclaw/bin/*.sh
```

Smoke-test by hand before letting launchd touch them:

```bash
~/.openclaw/bin/bb-healthcheck.sh
# Walk through the 8 checks, expect mostly OK lines

~/.openclaw/bin/bb-selfheal.sh
# Should print "Initial healthcheck PASSED — nothing to do"
```

---

## 8. Wiring the self-heal into launchd

Same pattern as the gateway: a system LaunchDaemon running as `puddles`, with `StartInterval=900` for "every 15 minutes" and `RunAtLoad=true` so the first run happens at boot.

`/Library/LaunchDaemons/ai.openclaw.bb-selfheal.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>ai.openclaw.bb-selfheal</string>

    <key>UserName</key>
    <string>puddles</string>
    <key>GroupName</key>
    <string>staff</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>/Users/puddles/.openclaw/bin/bb-selfheal.sh</string>
    </array>

    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>/Users/puddles</string>
        <key>USER</key>
        <string>puddles</string>
        <key>LOGNAME</key>
        <string>puddles</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>

    <key>StartInterval</key>
    <integer>900</integer>

    <key>RunAtLoad</key>
    <true/>

    <key>StandardOutPath</key>
    <string>/Users/puddles/.openclaw/logs/bb-health/selfheal.log</string>
    <key>StandardErrorPath</key>
    <string>/Users/puddles/.openclaw/logs/bb-health/selfheal.err.log</string>
</dict>
</plist>
```

Install it the same way as the gateway plist:

```bash
sudo install -o root -g wheel -m 644 \
  /Users/puddles/git/puddles/scripts/mac-mini/ai.openclaw.bb-selfheal.plist \
  /Library/LaunchDaemons/ai.openclaw.bb-selfheal.plist

sudo launchctl bootstrap system /Library/LaunchDaemons/ai.openclaw.bb-selfheal.plist
sudo launchctl enable system/ai.openclaw.bb-selfheal
```

Force a run right now to confirm it works end-to-end:

```bash
sudo launchctl kickstart -k system/ai.openclaw.bb-selfheal
sleep 5
tail ~/.openclaw/logs/bb-health/selfheal.log
# → [TIMESTAMP] === bb-selfheal start ===
# → [TIMESTAMP] Initial healthcheck PASSED — nothing to do
```

15 minutes is a deliberate choice. Fast enough that I won't notice an outage in casual use, slow enough that a buggy fix doesn't turn into a thrash loop. If the gateway is genuinely broken and the self-heal can't fix it, the script exits 1, the failure is in the log, and `launchctl list | grep openclaw` will show it — but it won't try again for another 15 minutes, which is exactly what I want.

---

## 9. Verifying everything works

Run through this checklist. Every line should pass.

```bash
# As puddles, on the Mini

# 1. BlueBubbles is up
pgrep -x BlueBubbles && lsof -nP -iTCP:1234 -sTCP:LISTEN | head -1
# → pid line + a "BlueBubbles ... TCP *:1234 (LISTEN)" line

# 2. Authed BB ping
PW=$(jq -r .providers.bluebubbles.apiKey ~/.openclaw/secrets.json)
curl -s "http://127.0.0.1:1234/api/v1/ping?password=$PW"
# → {"status":200,"message":"pong","data":null}

# 3. Gateway healthz
curl -s http://127.0.0.1:18789/healthz
# → {"ok":true}

# 4. Webhook URL stored in BB has the password param
sqlite3 ~/Library/Application\ Support/bluebubbles-server/config.db \
  "SELECT url FROM webhook;"
# → http://127.0.0.1:18789/bluebubbles-webhook?password=...

# 5. LaunchDaemons loaded
sudo launchctl list | grep openclaw
# → ai.openclaw.gateway       (last exit 0, may show PID)
# → ai.openclaw.bb-selfheal   (last exit 0, may show PID)

# 6. Healthcheck passes end-to-end
~/.openclaw/bin/bb-healthcheck.sh
# → eight OK lines, RESULT: HEALTHY
```

The big test: **text yourself.** Send "hi" from your iPhone to the Apple ID logged into the Mini. Within a few seconds:

- The gateway log should show `embedded run start … messageChannel=bluebubbles`
- A reply should land back in the Messages thread
- A typing indicator should fire while Puddles is composing (this confirms the Private API helper is wired up — without it you get the reply but no indicator)

Then **reboot the Mini**. Unlock it from your iPhone with the §12 flow from guide 01. Once `puddles` is logged in, BlueBubbles auto-starts, the gateway LaunchDaemon comes up, and within 15 minutes the self-heal timer fires its first post-boot check. Send another "hi" — it should just work, with no manual `launchctl` anywhere.

---

## 10. Where to go next

You can now text your agent and he'll text back. If something breaks at 3am, the LaunchDaemon catches it within 15 minutes and your morning self never knows.

What's not in this guide and is coming later:

- **Onboarding other people** (family, friends) with per-sender policy and tool allowlists. That's Phase 8.
- **Apple PIM** (Calendar, Reminders, Contacts) so Puddles can do useful things in response to your texts, not just chat.

---

## 11. Appendix: gotchas worth re-reading

1. **BlueBubbles permissions need a real GUI session.** Full Disk Access, Accessibility, and Automation prompts can't be approved over SSH. VNC in as `puddles` and click them yourself.
2. **Messages.app must be running in `puddles`' GUI session** — which means the §11/§12 unlock dance from guide 01 isn't optional. Pre-login SSH unlock alone leaves Messages.app dead and BlueBubbles with nothing to bridge.
3. **Use a system LaunchDaemon, not a per-user LaunchAgent.** `KeepAlive` only fires reliably in the system domain, and the daemon survives logouts and accidental `launchctl bootout`s.
4. **Run the daemon as `puddles`, not root.** Compromise of the gateway should land an attacker in the same place as compromise of the agent — one user, no sudo.
5. **`ThrottleInterval=5` matters.** Without it, a process that crashes on startup respawns as fast as launchd can fork, which on Apple Silicon is "very fast."
6. **macOS doesn't ship `timeout(1)`.** Use `perl -e 'alarm shift; exec @ARGV' N <cmd>`. Wrap the call in `bash -c '…' 2>/dev/null` to swallow the "Alarm clock" job-status noise.
7. **Messages.app AppleScript can hang while iMessage works perfectly.** BlueBubbles' Private API uses an injected helper bundle, not AppleScript. Treat the AppleScript bridge as informational only — never restart on it.
8. **Don't `launchctl kickstart` the gateway from the self-heal script.** Just `kill` the pid and let `KeepAlive` respawn it. One mechanism, one failure mode, no surprises.
9. **The webhook URL lives in `~/Library/Application Support/bluebubbles-server/config.db`.** If you ever need to manually fix it, that's the table (`webhook`, column `url`) to edit. The self-heal script does this for you when the password param goes missing.
10. **DM allowlist before anything else.** Default-open is "anyone with my number can talk to my agent." That's wrong. Set `dmPolicy=allowlist` first, add real numbers second.
