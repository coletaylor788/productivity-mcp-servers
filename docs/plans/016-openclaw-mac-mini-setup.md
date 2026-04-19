# OpenClaw Mac Mini Setup Plan

## Overview
Set up OpenClaw on a Mac Mini (M4) with native Apple integrations (iMessage, Calendar, Reminders, Contacts), proper sandbox + tool gate architecture, and hardened network security.

## Current State (Updated April 18, 2026)

### Accounts
- **cole** — admin account, local only (no Apple ID), used for system management and sudo operations
  - Apple ID was initially signed in, then removed to minimize attack surface
  - No personal data stored on this account
- **puddles** — standard (non-admin) account with his own Apple ID, runs OpenClaw and all agent services
  - Separate Apple ID for iMessage, Calendar, Reminders, Contacts
  - **Primary remote-unlock user**: his password unlocks FileVault and logs him in in one step (see 6.2)

### SSH Access
- Secure Enclave SSH keys (ECDSA P-256, Touch ID per connection) configured for both accounts
  - Key created via `sc_auth create-ctk-identity` with `-t bio` (biometric required)
  - Key handle exported via `ssh-keygen -w /usr/lib/ssh-keychain.dylib -K`
  - `SSH_SK_PROVIDER=/usr/lib/ssh-keychain.dylib` set in `~/.zshrc`
  - Private key is hardware-bound (never leaves Secure Enclave, cannot be extracted)
  - Same key authenticates to both cole and puddles accounts
- Termius on iPhone (free tier) holds the unlock password in iOS Keychain, Face ID gated — used for pre-login FileVault unlock over LAN

### Networking
- VLAN "Puddles-Pond" (192.168.8.0/24) on UniFi Dream Machine
- DHCP reservation: 192.168.8.230 (ethernet)
- Hostname: Coles-Mac-mini.local
- **WiFi disabled entirely** — ethernet only (required for pre-login SSH unlock; reduces attack surface)
- **Local firewall**: SSH (22) on LAN reachable via inter-VLAN allow rule (working). Screen Sharing (5900) on LAN currently blocked — UniFi rule format quirk being investigated. Tailscale path always works for both.
- Puddles-Pond → all other VLANs: blocked (Drop)
- Default → Puddles-Pond: explicit allow rule for SSH/VNC ports (so MacBook on default VLAN can unlock the box on home LAN)

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
Execute setup in phases, each building on the last. All commands run as the `puddles` user via SSH unless noted otherwise.

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

### 6.1 — Headless reliability checklist ("shit just works")

**Energy & Startup (Settings → Energy):**
- Prevent automatic sleeping when display is off
- Start up automatically after power failure
- Wake for network access (enables Wake-on-LAN over ethernet)
- Display sleep: 10 min ok (irrelevant headless)
- Kernel-panic auto-restart: on by default on Apple Silicon. The `sudo systemsetup -setrestartfreeze on` command (covers soft hangs) returns error -99 unless Terminal has Full Disk Access; skip it unless you specifically want this

**Lock Screen (Settings → Lock Screen):**
- "Require password after screen saver begins or display is turned off" → **Immediately** (or 5s)
- "Start Screen Saver when inactive" → 5 min
- "Turn display off when inactive" → 5–10 min
- "Login window shows" → **Name and password** (not user list — minor hardening)
- **Why lock?** Background services run regardless of lock state. Locking just protects the physical box if someone walks up.

**Network (Settings → Network):**
- WiFi → **Off entirely**, uncheck "Ask to join networks" (ethernet only — prevents fallback if cable yanked, reduces attack surface, required for pre-login SSH unlock)
- Confirm DHCP reservation in UniFi (`192.168.8.230`)
- Hostname: verify `Coles-Mac-mini` via `scutil --get HostName` (set with `sudo scutil --set HostName ...` if needed)

**Sharing (Settings → General → Sharing):**
- ✅ Screen Sharing
- ✅ Remote Login (SSH) — "Only these users" → cole, puddles
- ❌ Everything else (File, Media, Printer, Remote Management, Internet)

**puddles user session settings (apply by Screen Sharing in as puddles):**
- Notifications → **Do Not Disturb always on** (no popups eating Screen Sharing focus)
- Disable **Apple Intelligence / Siri**
- Disable **Spotlight web search/suggestions**
- Disable **Analytics & Improvements / Share with App Developers**
- Disable **AirDrop / Handoff**

**Login Items for puddles** (set up later as services come online):
- Tailscale (already system LaunchDaemon — runs at boot regardless of login)
- BlueBubbles
- OpenClaw agent
- Any other agent services
- **Pattern preference:** Prefer **system LaunchDaemons in `/Library/LaunchDaemons/`** over per-user LaunchAgents. Daemons run at boot independent of who's logged in (or whether anyone is). Only use LaunchAgents for things that genuinely need the user GUI session.

**Headless display quirk:**
- Without an HDMI display attached, Mac Mini may boot at 640×480 and Screen Sharing inherits that low resolution
- Either: keep an **HDMI dummy plug** attached, OR use [`displayplacer`](https://github.com/jakehilborn/displayplacer) to force a sensible resolution at login

**Recovery / theft protection on Apple Silicon:**
- True "Recovery Lock" as a discrete toggle is MDM-only on Apple Silicon
- For non-MDM Macs, **FileVault provides the equivalent protection automatically** — entering Recovery (or installing macOS, or wiping) requires the **owner credential** of a FileVault-enabled user. So enabling FileVault (next section) covers this for free
- (Old plans referenced `sudo bputil -E` — that flag does not exist; `bputil` exposes low-level boot policy and is not needed for our setup)

### 6.1.1 — macOS update strategy (unattended where safe)

**Auto-install: ON for safe categories**
- Settings → General → Software Update → Automatic Updates (gear icon):
  - ✅ Check for updates
  - ✅ Download new updates when available
  - ✅ Install Security Responses and system files (no reboot, low risk)
  - ❌ Install macOS updates (we control reboot timing)
  - ❌ Install application updates from the App Store (control)

**Manual but unattended-after-trigger workflow:**

For point releases (e.g. 26.1 → 26.2), use `softwareupdate` with `--user`/`--stdinpass` to leverage `fdesetup authrestart` — installs, reboots, FileVault auto-unlocks the one time, puddles auto-logs-in:

```bash
# Pipe password from Keychain so it never appears on screen or in history
security find-generic-password -a cole -s "macmini-admin" -w | \
  sudo softwareupdate --install --all --restart --user cole --stdinpass
```

Caveats:
- Requires cole to be a FileVault-enabled secure-token holder (default for primary admin)
- `authrestart` is **single-use** — multi-reboot updates will halt at FileVault for the second reboot
- **Do NOT auto-apply major OS upgrades** (e.g. Tahoe → next year's release). Trigger those manually with a window for handholding

**Notification of available updates:**
- Apple's built-in update notifications go to Notification Center on the logged-in user's screen → useless for headless
- Deferred to Phase 7 (see 7.1) — Puddles will check periodically and notify via his own channels

### 6.1.2 — Health monitoring
- Simple heartbeat: cron on puddles hits a private endpoint (e.g. `ntfy.sh/private-topic` or your own webhook) every N minutes
- Alert if heartbeat missed for X minutes — early warning for "Mac Mini is down"
- Can also be folded into Puddles' own self-monitoring once he's up

### 6.2 — FileVault + remote unlock (architecture)

**Why FileVault is now viable for a headless server:** macOS Tahoe 26 added "lightweight SSH" pre-user-login. After reboot, the box halts at FileVault unlock, but sshd responds with `"This system is locked. To unlock it, use a local account name and password"`. Entering a FileVault-enabled user's password completes the boot.

**Critical realization — pre-login SSH only unlocks the disk, NOT a GUI session:**
- Termius/SSH unlock on Tahoe completes FileVault disk unlock and lets boot proceed, but the box parks at **loginwindow** waiting for someone — no user is actually logged in
- Verified empirically: post-Termius-unlock, `who` is empty, `/dev/console` is owned by `root` (loginwindow), `launchctl print gui/<uid>` returns "Domain does not support specified action"
- **System LaunchDaemons** in `/Library/LaunchDaemons/` (e.g. Tailscale) DO start at boot regardless — that's why Tailscale comes back online without anyone logging in
- **per-user LaunchAgents** (anything depending on `Messages.app`, Apple ID Keychain, GUI frameworks — i.e. BlueBubbles) require a real GUI login to fire

**The two-step unlock flow (required for full service start):**
1. **Termius (SSH) → puddles@192.168.8.230 → enter password** — completes FileVault unlock, boot continues to loginwindow
2. **VNC client (Jump Desktop / RealVNC / Screens) → vnc://192.168.8.230 → enter VNC password → click puddles → enter macOS password** — creates the GUI session, LaunchAgents fire
3. Disconnect both. The GUI session persists until reboot — reconnects go straight to puddles' desktop, no re-login

Both steps use puddles' password. The first is for FileVault disk unlock, the second is for actual user login. Once logged in, the session sticks for the entire uptime.

**Architecture choice — FileVault unlock is NOT auto-login:**
- On Apple Silicon with FileVault enabled, **GUI auto-login is impossible** by design (`sysadminctl -autologin set` and the GUI both refuse: *"Automatic login is disabled because FileVault is enabled"*)
- The pre-login SSH unlock path is admin-credential-only at the SSH layer; it doesn't initiate a `loginwindow` login
- cole's password ALSO works for SSH unlock (good for emergency / physical access). For the GUI step, log in as puddles so his LaunchAgents start
- Both users must be FileVault-enabled secure-token holders (verified via `sudo fdesetup list`)

**Implication for service architecture:**
- **System LaunchDaemons** (`/Library/LaunchDaemons/`) start at boot regardless of who logs in — best for always-on services (Tailscale daemon already does this). After Termius unlock alone, daemons are up
- **puddles' LaunchAgents** (`~/Library/LaunchAgents/`) fire when puddles GUI-logs-in — required for things needing his Apple ID / Keychain / Messages.app (BlueBubbles, iMessage tooling)
- This dual pattern means power outage → Termius unlock → daemons up → VNC GUI login as puddles → agents up → fully operational

**Setup:**
- Enable FileVault: System Settings → Privacy & Security → FileVault → Turn On
  - Enable BOTH cole and puddles when prompted
  - Recovery key: store in **1Password** (NOT iCloud, since cole has no Apple ID)
- Verify Remote Login (SSH) is enabled — required for pre-login SSH unlock
- Mac Mini must be on **Ethernet** (pre-login SSH doesn't work over WiFi — WiFi password lives in a keychain that isn't unlocked yet)
- Pre-login SSH is **password-only** — does NOT accept SSH pubkey auth (verified empirically). Termius biometric SSH keys won't work for the unlock state, only for day-to-day SSH after boot.

**Network paths to the box:**

The Mac Mini's Tailscale daemon does NOT run pre-FileVault-unlock, so for power-outage-style recovery we need a second path to reach the LAN IP.

| Path | Use case | Reachable when Mac Mini Tailscale is offline? |
|---|---|---|
| Tailscale → `coles-mac-mini-1` | Day-to-day SSH, key-based with Touch ID | ❌ No |
| Home LAN (same network) → `192.168.8.230` | Remote unlock when home | ✅ Yes |
| Remote VPN to UDM → LAN IP | Remote unlock when away | ✅ Yes (once VPN works) |

**VPN-into-home options (need ONE of these for remote unlock when away from home):**
- **UniFi Teleport** (tried first): Built-in to UDM, WireGuard-based, uses Ubiquiti's hosted relay (no port forwarding, works behind CGNAT). **In our testing it never functioned** — phones connected to the WiFiman tunnel but no traffic reached the LAN, and devices never appeared in the UniFi client list. Status: deferred / probably broken on our UDM build.
- **WireGuard VPN Server on UDM** (fallback plan): Settings → VPN → VPN Server → WireGuard. Requires a port-forward (one UDP port) and either a static WAN IP or DDNS. More setup, but reliable and doesn't depend on Ubiquiti's relay.
- **Tailscale subnet router on a second always-on device** (third option): e.g. a Raspberry Pi advertising `192.168.8.0/24` to the tailnet — gives you LAN access via Tailscale even when the Mac Mini is offline.

**Power outage flow (validated end state):**
1. Power returns → Mac Mini boots → halts at FileVault unlock
2. **From phone (Termius)**: tap saved host → Termius auto-sends puddles' password to FV pre-boot stub → disk unlocks → Termius auto-reconnects to real sshd ~45s later → tap saved snippet `unlock-self.sh` → tap "Send Password" when the script prompts → script drives localhost VNC (Apple ARD auth + keystroke injection) to log puddles into the GUI session → snippet's "close session after running" closes Termius
3. **From MacBook (alternative)**: run `scripts/mac-mini/unlock.sh` → enter puddles' password once → script does both steps end-to-end
4. GUI session persists until next reboot. Disk was encrypted at rest the entire time.

### 6.2.2 — Operational tradeoffs and mitigations

The two-step unlock is friction. Mitigations:

**1. UPS (uninterruptible power supply) — strongly recommended**
- A small UPS (~$80–150, e.g. APC Back-UPS 600VA / CyberPower CP685AVR) gives 10–15 min runtime
- Most home power blips are <30s, so the UPS holds → Mac Mini never reboots → zero unlocks needed
- Long outages: UPS triggers graceful shutdown via USB signal (`pmset -a halfdim 1` + macOS UPS settings); on power return, two-step unlock required
- Reduces unplanned-unlock frequency from "every short blip" to "long outages only" (~1-2x/year)
- Bonus: clean shutdown protects the SSD from corruption

**2. Planned reboots use `fdesetup authrestart` — zero unlock**
- For macOS updates and any user-initiated reboot, stage the FV key in NVRAM so the next boot auto-unlocks AND macOS treats it as a console login by puddles → boots straight to his desktop, GUI session and all
- This is what `softwareupdate --restart --user puddles --stdinpass` does internally
- Works perfectly for: monthly updates, manual reboots, scheduled maintenance
- Does NOT work for power outages (can't pre-stage a key for an event you didn't anticipate)

**3. MacBook one-command unlock script — VALIDATED**
- Located at `scripts/mac-mini/unlock.sh` in this repo
- Single password prompt (puddles account); password never echoed or written to disk
- Step 1: `expect`-driven SSH to FV pre-boot stub for disk unlock (with diagnostic logging that doesn't expose the password; aborts cleanly on bad password / timeout / permission denied)
- Step 2: VNC connect to the Mini using **Apple ARD authentication** (Diffie-Hellman scheme 30) via `vncdotool`, then RFB keystroke injection (password + enter) into loginwindow after an 8-second pre-type sleep so the password field is focused
- ARD auth means we do NOT need "VNC viewers may control screen with password" enabled — disable that setting on the Mini; it's not used
- Requires `/usr/bin/python3 -m pip install --user vncdotool` on the runner machine
- Why the AppleScript-driving-Screen-Sharing.app approach was abandoned: focus race conditions caused the typed password to leak into the foreground app (Terminal). Raw RFB via vncdotool has no app focus involved — keystrokes go straight to the loginwindow over the VNC channel.

**4. iPhone one-tap (Termius) — VALIDATED**
- Same architecture as MacBook script, but the VNC step runs **on the Mini itself** instead of on the phone — eliminates the need for a-Shell, Jump Desktop, or any Python on iOS.
- One-time install on the Mini:
  - As puddles: `git clone` the repo, `python3 -m pip install --user vncdotool`
  - As cole (sudo required): `sudo install -m 0755 .../scripts/mac-mini/unlock-self.sh /usr/local/bin/unlock-self.sh`
- Termius setup on phone:
  - Save host `puddles@coles-mac-mini-1` with password stored in Termius keychain (Face-ID gated)
  - Create Snippet "Unlock Mini" with body `unlock-self.sh` and "Close session after running" enabled
- Per-reboot UX: open Termius → tap host → tap snippet → tap "Send Password" when the script prompts → done. Termius transparently handles the FV pre-boot SSH stub and reconnect to real sshd, so it looks like one continuous SSH session to the user.
- Why this works: once FV is unlocked, the Mini's sshd runs as root and accepts normal logins regardless of GUI state. The unlock-self script connects to `localhost::5900` via Apple ARD auth and injects keystrokes into its own loginwindow. macOS doesn't care that the VNC keystroke source is the same machine.

**5. Why not just disable FileVault?**
- APFS hardware encryption (Secure Enclave key) is always on, so disk extraction from a powered-off Mac is already protected
- The only marginal protection FileVault adds is against a sophisticated attacker who has stolen the powered-off Mac AND has the chops to bypass APFS HW key extraction
- For a stationary house server: low threat. Disabling FV would eliminate ALL unlock friction (auto-login becomes possible)
- We've chosen to keep FV ON for defense-in-depth, accepting the operational cost. Revisit if friction proves untenable

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
- iCloud sync via puddles' Apple ID

---

## Phase 7: Operational Tooling (Puddles-managed)

These are deferred until Puddles is running — he manages his own host.

### 7.1 — macOS update notifier
- Periodic check (`softwareupdate -l`)
- When updates are available, Puddles posts to your DM channel:
  - "macOS 26.x.y available: [release notes link]. Reply 'install' to apply."
- On approval: triggers the unattended update workflow (see 6.1.1)
- Lobster approval gate before reboot for safety

### 7.2 — Heartbeat / health monitoring
- Puddles posts a daily summary: uptime, disk usage, agent status, last successful boot
- Alert if subsystems (BlueBubbles, OpenClaw services) are down
- External heartbeat (cron → ntfy.sh) as backup for "Puddles himself is down"

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
12. **FileVault + auto-login are mutually exclusive on Apple Silicon** — both the GUI and `sysadminctl -autologin set` refuse with *"Automatic login is disabled because FileVault is enabled"*. Architecture: two-step unlock — Termius (SSH for FV disk unlock) + VNC (loginwindow for GUI session). Plan service layout accordingly (LaunchDaemons for always-on, puddles' LaunchAgents for things needing his GUI session)
13. **Pre-login SSH unlock does NOT log a user in** — it only unlocks the FileVault-encrypted disk so boot can continue to loginwindow. Verified empirically post-unlock: `who` empty, `/dev/console` owned by root, `launchctl print gui/<uid>` returns "Domain does not support specified action". A separate VNC login at loginwindow is required to start a real GUI session and fire per-user LaunchAgents
14. **Pre-login SSH (Tahoe 26) is password-only** — does NOT accept pubkey auth. Termius biometric SSH keys help with day-to-day SSH but not the unlock state. Verified empirically with `ssh -v` — server jumps straight to password prompt
14. **UniFi inter-VLAN port lists are quirky** — the LAN-In rule "Port" field accepts comma-separated lists (`22,5900`) and ranges (`22-5900`) in the UI but doesn't always parse them correctly. In our testing port 22 worked but 5900 didn't with a `22-5900` range. Safest pattern: one rule per port, OR a port group with each port listed individually
15. **UniFi Teleport unreliable** — connected but no LAN traffic flowed in our testing. WireGuard VPN Server on UDM is the more reliable fallback
16. **Lock screen vs. headless server** — counterintuitively, you DO want screen lock enabled even on a headless box. Background launchd jobs run regardless of lock state, and the lock protects the physical machine if anyone walks up
17. **Tahoe removed the GUI "Restart automatically if the computer freezes" toggle** — and `sudo systemsetup -setrestartfreeze on` returns error -99 unless Terminal has Full Disk Access. Apple Silicon auto-restarts on kernel panic by default; this flag only matters for soft hangs and is not worth the FDA dance for most setups
18. **`bputil -E` does not exist** — true MDM-style "Recovery Lock" is not exposed to non-MDM users. FileVault provides equivalent Recovery / wipe protection automatically (owner credential required)
19. **macOS Screen Sharing offers Apple ARD auth (Diffie-Hellman scheme 30) FIRST in the auth list** — a generic VNC client like vncdotool will pick it and require a username (not just a VNC password). Provide both `username=` and `password=` to vncdotool's `api.connect()` for ARD. As a side benefit, ARD obviates needing the "VNC viewers may control screen with password" setting
20. **Self-VNC works** — once FV is unlocked and sshd is up, the Mini can SSH in to itself (well, anything can SSH in) and connect to its OWN `localhost::5900` to drive its own loginwindow. macOS doesn't care that the VNC source is the same machine. This is what `unlock-self.sh` does, and it lets the iPhone do everything from Termius alone (no Jump Desktop, no Python, no a-Shell needed on the phone)
21. **Loginwindow needs ~5–8 seconds after VNC connect before the password field is focused** — typing too quickly drops keystrokes silently. Sleep at least 8s post-connect before typing
22. **`os._exit(0)` skips Python's stdout flush** — print messages can be swallowed by piped consumers. Use `print(..., flush=True)` if you need to confirm progress before _exit (which we do to work around vncdotool's twisted reactor not shutting down cleanly)
23. **expect with `>/dev/null 2>&1` hides everything** — including auth failures. Use `log_user 0` + `puts` for safe milestone logging that doesn't leak the password. Add explicit `denied|incorrect|failed|Permission denied|timeout` patterns to fail fast on bad input instead of marching on against a still-locked disk

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
