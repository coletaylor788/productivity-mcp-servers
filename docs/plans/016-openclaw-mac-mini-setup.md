# OpenClaw Mac Mini Setup Plan

## Overview
Set up OpenClaw on a Mac Mini (M4) with native Apple integrations (iMessage, Calendar, Reminders, Contacts), proper sandbox + tool gate architecture, and hardened network security.

## Current State (Updated April 17, 2026)

### Accounts
- **cole** — admin account, local only (no Apple ID), used for system management and sudo operations
  - Apple ID was initially signed in, then removed to minimize attack surface
  - No personal data stored on this account
- **puddles** — standard (non-admin) account with its own Apple ID, runs OpenClaw and all agent services
  - Separate Apple ID for iMessage, Calendar, Reminders, Contacts

### SSH Access
- Secure Enclave SSH keys (ECDSA P-256, Touch ID per connection) configured for both accounts
  - Key created via `sc_auth create-ctk-identity` with `-t bio` (biometric required)
  - Key handle exported via `ssh-keygen -w /usr/lib/ssh-keychain.dylib -K`
  - `SSH_SK_PROVIDER=/usr/lib/ssh-keychain.dylib` set in `~/.zshrc`
  - Private key is hardware-bound (never leaves Secure Enclave, cannot be extracted)
  - Same key authenticates to both cole and puddles accounts

### Networking
- VLAN "Puddles-Pond" (192.168.8.0/24) on UniFi Dream Machine
- DHCP reservation: 192.168.8.230 (ethernet)
- Hostname: Coles-Mac-mini.local
- **Local firewall ports 22/5900 are CLOSED** — all management via Tailscale only
- Puddles-Pond → all other VLANs: blocked (Drop)
- WiFi set to auto-join Puddles-Pond as ethernet fallback

### Tailscale
- Installed via Homebrew CLI (v1.96.4) — NOT App Store (GUI is sandboxed, can't host SSH)
- Running as system LaunchDaemon (`sudo brew services start tailscale`) — starts at boot before login
- Tailscale SSH enabled (`tailscale up --ssh`)
- Key expiry disabled for this device
- Tailnet hostname: `coles-mac-mini-1` (Tailscale IP: 100.66.225.105)
- Tagged as `tag:agent` in Tailscale ACLs
- ACL policy: personal devices → agent allowed, agent → personal devices blocked
- Screen Sharing accessible via `vnc://coles-mac-mini-1`
- Auto-update not supported on Homebrew install — weekly `brew upgrade` cron to be set up

### Installed Software
- Homebrew 5.1.6
- Node.js 22 (via Homebrew)
- Git (via Homebrew)
- Tailscale 1.96.4 (via Homebrew)

## Approach
Execute setup in 6 phases, each building on the last. All commands run as the `puddles` user via SSH unless noted otherwise.

---

## Phase 1: Core Infrastructure

### 1.1 — Install Homebrew
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"
```

### 1.2 — Install Tailscale (Homebrew CLI, NOT App Store)
```bash
brew install tailscale
brew services start tailscale
sudo tailscale up --ssh
```
- Authenticate via printed URL
- Tag as `tag:agent` in Tailscale ACLs — no outbound to personal devices
- Keep macOS sshd as fallback until Tailscale proven stable across reboots
- Once stable: close local firewall ports, re-enable VLAN isolation

### 1.3 — Install Node.js 22 + Git
```bash
brew install node@22 git
echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zshrc
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
```

---

## Phase 2: OpenClaw

### 2.1 — Install OpenClaw
```bash
npm install -g openclaw
```

### 2.2 — Run onboarding
```bash
openclaw onboard --install-daemon
```
- Sets up gateway auth, default agent, API key, daemon (auto-start on boot)

### 2.3 — Configure Telegram channel
- Migrate config from Azure instance

### 2.4 — Tailscale Serve (expose dashboard over tailnet)
```bash
sudo tailscale serve --bg 18789
```
- Keep gateway bound to 127.0.0.1

---

## Phase 3: iMessage + BlueBubbles

### 3.1 — Disable SIP (requires physical/recovery access)
- Shut down Mac completely
- Hold power button → Recovery → Utilities → Terminal → `csrutil disable`
- Restart

### 3.2 — Disable library validation
```bash
sudo defaults write /Library/Preferences/com.apple.security.libraryvalidation.plist DisableLibraryValidation -bool true
```

### 3.3 — Install BlueBubbles
```bash
brew install --cask bluebubbles
```
- Grant Full Disk Access + Accessibility in System Settings (via Screen Sharing)
- Set strong API password
- Enable Private API (typing indicators, read receipts, tapbacks, reply threading)
- Enable auto-start on login

### 3.4 — Connect BlueBubbles to OpenClaw
```bash
openclaw channels add --channel bluebubbles \
  --http-url http://127.0.0.1:1234 \
  --password "PASSWORD" \
  --webhook-path /bluebubbles-webhook
```

### 3.5 — Set DM policy
```bash
openclaw config set channels.bluebubbles.dmPolicy allowlist
openclaw config set 'channels.bluebubbles.allowFrom' '["+1COLE_PHONE"]'
```

---

## Phase 4: Apple PIM (Calendars, Reminders, Contacts)

### 4.1 — Install Apple PIM Agent Plugin
- Repo: https://github.com/omarshahine/Apple-PIM-Agent-Plugin
- Swift CLIs: `calendar-cli`, `reminder-cli`, `contacts-cli`
- Runs natively via EventKit — no cloud API needed
- First run: approve macOS TCC permission dialogs via Screen Sharing

### 4.2 — Share calendars/reminders from Cole → Puddles
- Calendar app → right-click calendar → Share → Puddles' Apple ID
- Reminders app → right-click list → Share → Puddles' Apple ID
- Accept sharing invitations on the Mac Mini

---

## Phase 5: Docker + Sandboxing

### 5.1 — Install Docker Desktop
```bash
brew install --cask docker
```
- Enable "Start on login"
- Used for sandboxed agents (restricted agents run in Docker containers)

---

## Phase 6: macOS Hardening

### 6.1 — Energy settings
- System Settings → Energy → Prevent sleep when display off
- Start up after power failure
- System Settings → Users & Groups → Auto-login → puddles
  - **Auto-login fires *after* FileVault unlocks**, so it's compatible with FileVault ON (see 6.2)
- Login Items for puddles: Tailscale, BlueBubbles, OpenClaw agent

### 6.2 — FileVault ON + remote unlock
**Why FileVault ON is now viable for a headless server:** macOS Tahoe 26 added "lightweight SSH" pre-user-login. After reboot, the box halts at FileVault unlock, but SSH responds with `"This system is locked. To unlock it, use a local account name and password"`. Entering an admin password completes the boot, then auto-login fires for puddles, then all services start.

**Setup:**
- Enable FileVault: System Settings → Privacy & Security → FileVault → Turn On
  - Recovery key: store in 1Password (NOT iCloud, since cole has no Apple ID)
- Verify Remote Login (SSH) is enabled in Sharing settings — required for pre-login SSH unlock
- Mac Mini must be on **Ethernet** (pre-login SSH doesn't work over WiFi — WiFi password lives in user keychain that isn't unlocked yet)

**Network architecture for remote unlock:**

The Mac Mini's Tailscale daemon does NOT run pre-FileVault-unlock, so we need a second path to reach the LAN IP. Use **UniFi Teleport** (built into the Dream Machine, WireGuard-based, no extra hardware, free).

**UniFi Teleport setup (one-time, on UDM):**
1. Update UniFi Network app + UDM firmware to latest
2. Open UniFi Network → Settings → VPN → **Teleport VPN**
3. Toggle **Enable Teleport** ON
4. Under "Invite User" → click **Generate Link** (creates a one-time WiFiman invite URL)
5. Note: Teleport uses Ubiquiti's hosted relay, so **no port forwarding** needed and works behind CGNAT
6. (Recommended) Set **DHCP Reservation** for the Mac Mini so its LAN IP doesn't change — UniFi Network → Client Devices → Mac Mini → Settings → Fixed IP Address (e.g. `192.168.8.230`)

**Client setup:**
- **iPhone/iPad:** Install [WiFiman](https://apps.apple.com/app/wifiman/id1385561119) from App Store → open the invite link from Step 4 (works once) → grants persistent VPN profile → enable VPN with one tap
- **MacBook:** Install WiFiman from Mac App Store → same invite link flow
- **Test:** Disable home WiFi (use cellular/different network) → enable Teleport → ping `192.168.8.230` → should respond

**Operational notes:**
- Teleport is a **full tunnel by default** — all traffic routes through home. Acceptable for occasional unlock; if you use it constantly, configure split tunneling in WiFiman settings
- Invite links expire — generate new ones if you reinstall the app or add a device
- One Teleport user can have multiple devices on the same invite

**Two paths to the box:**
| Path | Use case | Reachable when Mac Mini Tailscale is offline? |
|---|---|---|
| Tailscale → `coles-mac-mini-1` | Day-to-day SSH, key-based with Touch ID | ❌ No |
| UniFi Teleport → LAN IP | Remote unlock, recovery | ✅ Yes |

**Power outage flow:**
1. Power returns → Mac Mini boots → halts at FileVault unlock
2. From phone or laptop: connect Teleport → SSH to LAN IP → "system is locked" prompt
3. Enter admin password → Mac completes boot → auto-login as puddles → Tailscale/BlueBubbles/OpenClaw start
4. Disk was encrypted at rest the entire time

### 6.2.1 — One-tap unlock from phone or laptop

**iPhone:**
- Install **Termius** (free) + **WiFiman** (UniFi Teleport client)
- Termius: New Host → LAN IP → username `cole` → password (stored in iOS Keychain, Face ID gated)
- Flow: open WiFiman (one tap) → open Termius → tap host → Face ID → password auto-fed → unlock fires

**MacBook:**
- Store unlock password in Keychain (one-time, never goes through Copilot):
  ```bash
  security add-generic-password -a cole -s "macmini-unlock" -w
  ```
- Add to `~/.zshrc`:
  ```bash
  unlock-macmini() {
    local pw
    pw=$(security find-generic-password -a cole -s "macmini-unlock" -w) || return 1
    expect <<EOF
      set timeout 30
      spawn ssh cole@192.168.8.230
      expect {
        "Password:" { send "\$pw\r"; exp_continue }
        "*\$ " { send "exit\r" }
        timeout { exit 1 }
      }
      expect eof
EOF
  }
  ```
- Run `unlock-macmini` from anywhere on the tailnet OR via Teleport-routed LAN access

### 6.3 — Exec approvals config
- Per-agent command allowlists in `exec-approvals.json`
- `security: "allowlist"` + `ask: "on-miss"` — unlisted commands prompt Cole via Telegram
- Main agent: broader allowlist
- Restricted agents: minimal allowlist

### 6.4 — Inbound content pipeline
- Two-stage preprocessing: injection detection + secret scrubbing

### 6.5 — Security audit agent
- Cron-based isolated agent reviewing daily activity

### 6.6 — Backup
- iCloud sync via Puddles' Apple ID

---

## Security Architecture

### Account Model
- **Two-account separation**: admin (cole) handles system management; standard (puddles) runs all agent services
- **Admin account has no Apple ID** — removed after initial setup to eliminate personal data from the machine. If the agent account (puddles) is compromised via prompt injection and escalates privileges, there is no sensitive personal data in the admin account to exfiltrate
- **Standard account cannot sudo** — Homebrew installs and system config changes require Screen Sharing into the admin account. This is intentional friction
- **Full Disk Access is per-app, not per-user** — granting FDA to BlueBubbles does NOT give the puddles shell or other apps FDA. Each app must be explicitly added in System Settings

### SIP Disabled — Risk Acceptance
- SIP (System Integrity Protection) is disabled to enable BlueBubbles Private API
- **With SIP off, root can modify TCC.db** (the database controlling per-app permissions like Full Disk Access)
- Attack chain: prompt injection → code execution → privilege escalation to root → modify TCC.db → grant FDA to malicious process
- **Mitigations**: exec approvals (allowlisted commands only), Docker sandbox for untrusted code, Tailscale ACLs preventing lateral movement, network isolation via VLAN, admin account has no sensitive data
- If BlueBubbles Private API is not needed, SIP can stay enabled (basic iMessage send/receive still works)

### Network Security
- **VLAN isolation**: Dedicated "Puddles-Pond" (192.168.8.0/24) on UniFi Dream Machine
- **Local firewall**: Ports 22 and 5900 CLOSED on LAN — all management via Tailscale tunnel only
- **Tailscale ACLs**: Agent tagged as `tag:agent`, personal devices can reach agent, agent CANNOT reach personal devices (no outbound grant)
- **Tailscale SSH**: Replaces macOS sshd for remote access. Browser-based check on first connection per session
- **Screen Sharing**: Accessible only via Tailscale (`vnc://coles-mac-mini-1`)
- **BlueBubbles**: localhost only (127.0.0.1), never exposed to network
- **Telegram**: long polling (outbound only), no inbound ports needed
- **Outbound**: Internet allowed (LLM APIs, Telegram, Apple services, Google, web)
- **Inbound from internet**: All blocked

### Secrets Management
- macOS Keychain + OpenClaw SecretRef — no plaintext API keys on disk
- SSH private keys in Secure Enclave (hardware-bound, cannot be extracted)
- Never pass passwords through AI assistant sessions — use Screen Sharing for sudo operations

### Tailscale ACL Policy
```json
{
  "grants": [
    {"src": ["autogroup:member"], "dst": ["autogroup:self"], "ip": ["*"]},
    {"src": ["autogroup:member"], "dst": ["tag:agent"], "ip": ["*"]},
  ],
  "ssh": [
    {"action": "check", "src": ["autogroup:member"], "dst": ["autogroup:self"], "users": ["autogroup:nonroot", "root"]},
    {"action": "check", "src": ["autogroup:member"], "dst": ["tag:agent"], "users": ["autogroup:nonroot", "root"]},
  ],
  "tagOwners": {"tag:agent": ["autogroup:admin"]},
}
```

---

## Gotchas & Lessons Learned

1. **Homebrew requires admin** — install under the admin account, not the standard account. Both accounts can use brew after install
2. **Tailscale: use Homebrew CLI, NOT App Store** — the App Store version is sandboxed and cannot host SSH
3. **Tailscale: use `sudo brew services start` for LaunchDaemon** — `brew services start` (without sudo) creates a LaunchAgent that only runs when the user is logged in. The sudo version creates a system LaunchDaemon that starts at boot
4. **Tailscale: disable key expiry** for always-on servers — default 180-day expiry will silently disconnect the machine
5. **Tailscale: auto-update not supported on Homebrew** — set up a weekly `brew upgrade` cron
6. **Killing the manual tailscaled before starting brew service** — if you test with a manual `tailscaled &`, kill it before switching to the brew service or they'll conflict
7. **Re-authentication needed after daemon restart** — switching from manual to brew service daemon loses the auth state. Run `sudo tailscale up --ssh` again
8. **Secure Enclave SSH keys use ECDSA P-256, not Ed25519** — macOS Secure Enclave doesn't support Ed25519. The `ed25519-sk` approach (FIDO2) is NOT supported by Apple's built-in OpenSSH
9. **`sc_auth create-ctk-identity`** is the correct tool for Secure Enclave keys, not `ssh-keygen -t ed25519-sk`
10. **Never pass passwords through AI assistant sessions** — they get logged to events.jsonl. Use Screen Sharing for any sudo/password operations
11. **HDMI dummy plug recommended** — without it, Screen Sharing may show a blank screen on a headless Mac Mini

---

## Reference
- Omar's Lobster Playbook: https://lobster.shahine.com
- Apple PIM Plugin: https://github.com/omarshahine/Apple-PIM-Agent-Plugin

## Inter-Agent Communication (Lobster Approval Gates)

When Group Puddles needs Main Puddles to take action on your behalf, requests go through the Lobster workflow plugin — not direct agent-to-agent messaging.

### How it works
1. Group Puddles detects an actionable request from the group chat (calendar event, reminder, email, etc.)
2. Instead of messaging Main Puddles directly, it kicks off a Lobster workflow
3. **Step 1**: Format the request into a structured payload
4. **Step 2**: Approval gate — you get a prompt in your DM asking to approve or deny
5. **Step 3**: Only if you approve, the request gets delivered to Main Puddles and the action executes

### Why this matters
- Main Puddles never even processes the request unless you've approved it
- No one in a group chat can put stuff on your calendar, set reminders, or trigger actions without your explicit tap
- The approval is enforced by the Lobster runtime, not by AI instructions — it physically can't skip the gate

### Security layers (belt + suspenders + a third belt)
- **Layer 1**: Group agent has no calendar/exec tools at all (system-enforced tool policy)
- **Layer 2**: Lobster approval gate blocks the request from reaching Main Puddles (runtime-enforced)
- **Layer 3**: Exec approvals on Main Puddles gate the actual CLI execution (system-enforced)

### Dependencies
- Lobster CLI installed on Mac Mini (brew or npm)
- Lobster plugin enabled for the group agent
- Approval prompts forwarded to Telegram/iMessage DM

---

## Future Features (post-migration)
- Morning briefing (calendar, weather, emails, reminders)
- Powder alerts (NWAC + resort snow reports, early AM texts on big days)
- Avy forecast summaries for touring zones
- Crystal parking monitor
- Smart home / HomeKit integration
- Kona care (vet, flea/tick meds, food reorder)
- Multi-agent architecture (family/group agents — Phase 2)
- NOT work stuff — keep work and home separate
