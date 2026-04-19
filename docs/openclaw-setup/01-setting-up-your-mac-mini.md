# Setting up your Mac Mini

This guide takes you from a brand-new (or freshly reinstalled) Mac Mini to a hardened, headless, remotely-manageable server suitable for running a personal AI agent — or really any always-on home service.

When you're done, you'll have:

- A Mac Mini you can run **without a monitor, keyboard, or mouse**
- **Two accounts** with clean separation: an admin you rarely log into, and a "service" account that runs everything
- **Encrypted disk** (FileVault) that you can unlock remotely after a power outage from your phone or laptop in about three taps
- **SSH access** gated by Touch ID on your other Apple devices, with no exportable private keys anywhere
- **Tailscale** for zero-config secure access from anywhere
- Network isolation on its own VLAN
- **Automated weekly software updates** for installed packages
- **iCloud-backed runtime data** so a Mac wipe never costs you anything you care about

If you stop after this guide and never install an AI agent on top, you still end up with a perfectly serviceable home server. Everything that follows in the OpenClaw series builds on this foundation.

> **Time:** about half a day, mostly waiting on FileVault to encrypt and software to install.
> **Skill:** comfortable with the command line and willing to read a UniFi controller. No programming required.

---

## Table of contents

1. [What you'll build (architecture)](#1-what-youll-build-architecture)
2. [Security model](#2-security-model)
3. [What you need before starting](#3-what-you-need-before-starting)
4. [Initial macOS install and accounts](#4-initial-macos-install-and-accounts)
5. [Network: VLAN, ethernet, hostname](#5-network-vlan-ethernet-hostname)
6. [Sharing services and lock screen](#6-sharing-services-and-lock-screen)
7. [SSH with Secure Enclave keys (Touch ID)](#7-ssh-with-secure-enclave-keys-touch-id)
8. [Tailscale](#8-tailscale)
9. [Homebrew and base tools](#9-homebrew-and-base-tools)
10. [FileVault and the two-step unlock model](#10-filevault-and-the-two-step-unlock-model)
11. [One-command unlock from your MacBook](#11-one-command-unlock-from-your-macbook)
12. [One-tap unlock from your iPhone](#12-one-tap-unlock-from-your-iphone)
13. [Automated weekly Homebrew updates](#13-automated-weekly-homebrew-updates)
14. [iCloud backup convention](#14-icloud-backup-convention)
15. [Verifying everything works](#15-verifying-everything-works)
16. [Where to go next](#16-where-to-go-next)
17. [Appendix: gotchas worth re-reading](#17-appendix-gotchas-worth-re-reading)

---

## 1. What you'll build (architecture)

### Hardware

- **Mac Mini M4** (any Apple Silicon Mac will work; this guide is written for the M4 base model)
- Wired ethernet to your home router or switch
- An **HDMI dummy plug** (recommended — see §6) or a real monitor for first-time setup

### Logical layout

```
                    ┌─────────────────────────────┐
                    │   Mac Mini M4 (headless)    │
                    │                             │
    Touch ID SSH    │  cole (admin)               │
   ────────────────►│   - rarely logged in        │
                    │   - no Apple ID             │
                    │   - owns Homebrew           │
                    │                             │
    Daily use as    │  puddles (standard user)    │
    the agent ────►│   - has its own Apple ID    │
                    │   - runs all services       │
                    │   - cannot sudo             │
                    │                             │
                    │  System LaunchDaemons       │
                    │   - Tailscale (always on)   │
                    │   - brew autoupdate (Sun)   │
                    └─────────────────────────────┘
                         │            │
                         │            │ iCloud Drive
                         │            ▼
                         │     puddles' Apple ID
                         │       (data backup)
                         │
                  ┌──────┴──────┐
                  │  Tailscale  │   ← always-on encrypted overlay
                  │   tailnet   │
                  └──────┬──────┘
                         │
              ┌──────────┼──────────┐
              ▼          ▼          ▼
          MacBook     iPhone     Future devices
        (Touch ID)  (Termius)
```

### Two paths in

Because Tailscale doesn't run until the disk is unlocked, after a power outage you need a **second path** to reach the box on the LAN:

| Path                                  | When to use                          | Works pre-FileVault-unlock? |
|---------------------------------------|--------------------------------------|-----------------------------|
| Tailscale → `coles-mac-mini-1`        | Day-to-day SSH from anywhere         | ❌                          |
| Home LAN → `192.168.8.230`            | Unlocking after power loss, at home  | ✅                          |
| VPN into UniFi → LAN IP               | Unlocking after power loss, away     | ✅ (once VPN configured)    |

This guide configures Tailscale + LAN. The "VPN into your UDM" piece is deferred — fine to skip if you're rarely away from home for long enough to lose power.

---

## 2. Security model

This is a **personal home server** with **occasional remote access**, run by one technically-comfortable user. The threat model and choices reflect that. If you're protecting something more sensitive, harden further.

### What we defend against

- **Casual physical theft** — encrypted disk, owner-credential-required recovery
- **Lateral movement from other devices on your home network** — VLAN isolation, no inbound ports beyond what's needed, default-deny
- **Remote attacker on the internet** — no inbound ports forwarded; everything inbound goes through Tailscale's authenticated tunnel
- **Compromise of the agent itself (e.g. via prompt injection)** — admin/agent split, no Apple ID on admin, network egress limited by VLAN ACLs (later phases add per-tool exec allowlists)

### What we explicitly accept

- **Loss of the entire OS install.** We back up *data we'd hate to lose*, not the system itself. A wipe + this guide rebuilds it.
- **Two-step unlock friction after power loss.** We've chosen FileVault on, accepting that a reboot needs an unlock dance instead of a clean auto-login.

### Key design choices and their reasons

| Choice                                            | Why                                                                                                  |
|---------------------------------------------------|------------------------------------------------------------------------------------------------------|
| Two accounts (admin + standard)                   | Compromise of the agent doesn't give attacker sudo. Admin has no personal data to exfiltrate.        |
| Admin has no Apple ID                             | Attack surface reduction — no iCloud, no Keychain sync, nothing personal on that account             |
| FileVault on                                      | Defense in depth on top of the always-on Apple Silicon hardware encryption                           |
| Wired ethernet only, WiFi disabled                | Pre-login SSH unlock requires ethernet. Also halves the attack surface.                              |
| Secure Enclave SSH keys                           | Private key cannot be extracted from the chip — even root can't get it                                |
| Tailscale (Homebrew CLI, not App Store)           | App Store version is sandboxed, can't host SSH; CLI version runs as a system daemon                  |
| Tailscale ACLs: agent CANNOT reach personal devices | Limits blast radius if the agent is compromised                                                    |
| Lock screen on, even though headless              | Background services run regardless of lock state; lock just protects the physical box if anyone walks up |
| iCloud Drive on puddles' Apple ID                 | Free, automatic backup of `~/Documents` so we can wipe and recover                                   |

---

## 3. What you need before starting

**On the Mac Mini:**
- macOS 26 (Tahoe) or newer — this guide depends on Tahoe's pre-login SSH unlock feature
- Wired ethernet
- HDMI display (or a dummy plug — see §6) for the first hour of setup

**On your other gear:**
- A MacBook on the same LAN you'll use for setup
- An iPhone (we'll use Termius, free tier)
- A UniFi Dream Machine (or any router that supports VLANs — instructions are UDM-specific but adapt easily)
- A password manager you trust (this guide assumes 1Password for the FileVault recovery key — anything works)

**Two Apple IDs ready:**
- One for **puddles** (the agent account) — we'll sign into iCloud with this
- The admin (**cole**) intentionally does NOT use an Apple ID

**Names used throughout this guide** (substitute your own):
- Admin user: **cole**
- Service user: **puddles**
- Hostname: **Coles-Mac-mini** (`coles-mac-mini-1` on the tailnet)
- LAN IP: **192.168.8.230** on VLAN **Puddles-Pond** (192.168.8.0/24)

---

## 4. Initial macOS install and accounts

1. Boot the Mac Mini, complete Apple's Setup Assistant.
2. **Don't sign into any Apple ID** when prompted. Skip it. (We'll sign puddles into iCloud later, in §14.)
3. Create the **first user as `cole`**, set as admin. Use a strong password — this is the FileVault unlock you'll be typing for years.
4. After reaching the desktop, open **System Settings → Users & Groups** and create a second user **`puddles`**, type **Standard** (not Administrator). Strong password.
5. Run software updates: **System Settings → General → Software Update**. Apply everything, reboot, repeat until clean.

**Why no Apple ID on cole:** if puddles is ever compromised and the attacker pivots to root, there's no Keychain or iCloud account on the admin account to exfiltrate.

---

## 5. Network: VLAN, ethernet, hostname

### On the UniFi controller

1. Create a new network: **Puddles-Pond**, `192.168.8.0/24`, isolated VLAN.
2. Add a **firewall rule**: traffic from Puddles-Pond → all other VLANs = **Drop**. (Default-deny outbound from the agent network.)
3. Add a **firewall rule**: traffic from Default VLAN → Puddles-Pond, allow ports `22` and `5900` (SSH and VNC). One rule per port — UniFi's port-list parsing has been quirky in our testing; safest to list each individually or use a port group.
4. Plug the Mac Mini into a switch port assigned to the Puddles-Pond network.
5. Wait for the Mini to get an IP, then create a **DHCP reservation** for it at `192.168.8.230`.

### On the Mac Mini (logged in as cole)

```bash
# Set the hostname (otherwise it'll be something like "Coles-Mac-mini-2" with a random suffix)
sudo scutil --set HostName Coles-Mac-mini
sudo scutil --set LocalHostName Coles-Mac-mini
sudo scutil --set ComputerName Coles-Mac-mini
```

In **System Settings → Network**:
- Turn **WiFi off** entirely (click the WiFi entry → toggle off → also uncheck "Ask to join networks"). Ethernet only.

Why WiFi off: pre-login SSH unlock (the headline FileVault feature in §10) doesn't work over WiFi — the WiFi password lives in a keychain that isn't unlocked until you're logged in. And it cuts attack surface in half.

---

## 6. Sharing services and lock screen

In **System Settings → General → Sharing**, enable:
- ✅ **Screen Sharing**
- ✅ **Remote Login** (SSH) — set to "Only these users" → cole, puddles
- ❌ Everything else (File Sharing, Media Sharing, Printer Sharing, Remote Management, Internet Sharing) — leave off

In **System Settings → Lock Screen**:
- Require password after screen saver: **Immediately**
- Start Screen Saver when inactive: 5 min
- Turn display off when inactive: 10 min
- Login window shows: **Name and password** (not the user list — minor hardening)

Yes, lock the screen even though no one's looking at it. Background services run regardless of lock state, and the lock protects the physical box if someone walks up.

In **System Settings → Energy**:
- Prevent automatic sleeping when display is off: **on**
- Start up automatically after power failure: **on**
- Wake for network access: **on** (enables Wake-on-LAN over ethernet)

### The headless display quirk

A Mac Mini with no display attached often boots at **640×480**. Screen Sharing inherits that resolution and looks awful. Two ways to fix:

- **HDMI dummy plug** (~$10) — pretend a 4K monitor is attached. Simplest. Recommended.
- **`displayplacer`** — install via Homebrew (later) and force a sensible resolution at login.

Pick one. The dummy plug is set-and-forget.

---

## 7. SSH with Secure Enclave keys (Touch ID)

We want SSH keys that **physically cannot be extracted from your devices** — not by you, not by an attacker who pwns your laptop, not by anyone. macOS has had Secure Enclave-backed SSH support since Monterey but it's not signposted well.

> **Important:** macOS Secure Enclave does NOT support `ed25519`. It uses **ECDSA P-256**. Don't waste time on `ssh-keygen -t ed25519-sk` (FIDO2) — Apple's bundled OpenSSH doesn't support it.

On each Mac you want to SSH **from** (your MacBook, etc.):

```bash
# Create the Secure Enclave key (biometric required per use)
sc_auth create-ctk-identity -t bio -l 'Mac Mini SSH'

# Export the SSH key handle (NOT the private key — that stays in the Enclave forever)
ssh-keygen -K -w /usr/lib/ssh-keychain.dylib

# This drops two files in the cwd: id_ecdsa_sk_rk and id_ecdsa_sk_rk.pub
mkdir -p ~/.ssh
mv id_ecdsa_sk_rk* ~/.ssh/

# Tell SSH where the Secure Enclave provider lives (persist in zshrc)
echo 'export SSH_SK_PROVIDER=/usr/lib/ssh-keychain.dylib' >> ~/.zshrc
export SSH_SK_PROVIDER=/usr/lib/ssh-keychain.dylib
```

Copy `~/.ssh/id_ecdsa_sk_rk.pub` and on the **Mac Mini**, add it to **both accounts'** `~/.ssh/authorized_keys`:

```bash
# Run as cole, then again as puddles (or scp + sudo into puddles' homedir)
mkdir -p ~/.ssh && chmod 700 ~/.ssh
echo 'sk-ecdsa-sha2-nistp256@openssh.com AAAA...your-pub-key...' >> ~/.ssh/authorized_keys
chmod 600 ~/.ssh/authorized_keys
```

Test from your MacBook — Touch ID prompt should pop up:

```bash
ssh cole@192.168.8.230
ssh puddles@192.168.8.230
```

The same key works on both accounts. The private key never leaves the Secure Enclave; even root on your MacBook can't dump it.

---

## 8. Tailscale

Tailscale gives you encrypted access to the Mini from anywhere, no port forwarding, no DDNS.

### Install (as cole, via SSH)

```bash
# Homebrew first — see §9 if you haven't done that yet, but it's fine to do this now
brew install tailscale

# Critical: use SUDO for brew services. Without sudo, it creates a per-user
# LaunchAgent that only runs when cole is logged in (i.e. never, on a headless server).
# WITH sudo, it creates a system LaunchDaemon that runs at boot.
sudo brew services start tailscale

# Bring up Tailscale and enable Tailscale SSH
sudo tailscale up --ssh
```

Open the printed URL on your laptop, authenticate, and:
- **Tag the device** as `tag:agent`
- **Disable key expiry** for this device (default 180-day expiry will silently disconnect a server)

### ACL policy

In the Tailscale admin console, set ACLs so the agent device can be **reached by** your personal devices but **cannot reach them back**:

```jsonc
{
  "grants": [
    {"src": ["autogroup:member"], "dst": ["autogroup:self"], "ip": ["*"]},
    {"src": ["autogroup:member"], "dst": ["tag:agent"],     "ip": ["*"]},
  ],
  "ssh": [
    {"action": "check", "src": ["autogroup:member"], "dst": ["autogroup:self"], "users": ["autogroup:nonroot", "root"]},
    {"action": "check", "src": ["autogroup:member"], "dst": ["tag:agent"],      "users": ["autogroup:nonroot", "root"]},
  ],
  "tagOwners": {"tag:agent": ["autogroup:admin"]},
}
```

The asymmetry — agent has no outbound grant — is the whole point. If puddles is compromised, the attacker can't pivot through Tailscale to your laptop.

Test from elsewhere:
```bash
ssh puddles@coles-mac-mini-1   # works from any tailnet device
```

---

## 9. Homebrew and base tools

As **cole** (admin), via SSH:

```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
eval "$(/opt/homebrew/bin/brew shellenv)"

brew install node@22 git
echo 'export PATH="/opt/homebrew/opt/node@22/bin:$PATH"' >> ~/.zshrc
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
```

> **Important:** Homebrew is **owned by whoever installed it.** `/opt/homebrew` ends up writable by cole and ONLY cole. Anything that runs `brew upgrade` later (including the autoupdate job in §13) MUST run as cole. We'll handle that with a system LaunchDaemon configured to run as the cole user.

---

## 10. FileVault and the two-step unlock model

### Enable FileVault

On the Mini (you'll need physical/VNC access for this, since it requires interactive prompts as both users):

1. **System Settings → Privacy & Security → FileVault → Turn On**
2. When prompted, enable BOTH `cole` and `puddles` as FileVault users (both must be secure-token holders).
3. **Recovery key:** store it in your password manager (1Password). NOT iCloud, since cole has no Apple ID to sync it to.
4. Wait for encryption to finish (can take an hour or more on first run).

Verify both users are enabled:
```bash
sudo fdesetup list
# Should show both cole and puddles
```

### What happens after a reboot — read this carefully

This is the part of headless macOS that catches everyone. After a reboot, FileVault halts the boot process at a pre-login stub. Two distinct things have to happen before the box is "really" running:

**Step 1 — Disk unlock (FileVault).** You SSH to the Mini's pre-login stub (it responds with `"This system is locked. To unlock it, use a local account name and password"`) and enter a FileVault-enabled user's password. The disk decrypts and boot continues.

After step 1, you have:
- ✅ Disk decrypted
- ✅ macOS booted
- ✅ **System LaunchDaemons running** (Tailscale, sshd, the brew autoupdate timer)
- ❌ **No user logged in** — the box is parked at the loginwindow
- ❌ **Per-user LaunchAgents NOT running** (Messages.app, anything needing the Apple ID Keychain, the agent itself once we install it)

This is a real surprise the first time. Empirically: post-step-1, `who` is empty, `/dev/console` is owned by root, and `launchctl print gui/<uid>` returns "Domain does not support specified action". The Tailscale daemon is up because it's a *system* LaunchDaemon. But anything that needs puddles' GUI session is dead in the water.

**Step 2 — GUI login.** A VNC client connects to the loginwindow and types puddles' password into the password field. NOW puddles' user session exists, his LaunchAgents fire, and the system is fully operational.

### Why we can't just enable auto-login

On Apple Silicon, **GUI auto-login is impossible while FileVault is on**. Both the System Settings GUI and `sysadminctl -autologin set` refuse with: *"Automatic login is disabled because FileVault is enabled"*. This isn't a bug; it's by design.

### Why we don't disable FileVault

Apple Silicon's APFS hardware encryption is always on, which already protects against disk extraction. So why pay the friction cost of FileVault?

- Defense in depth against a sophisticated attacker who has physical possession of the powered-off Mac
- FileVault is also what makes the Mini require an owner credential to enter Recovery / wipe / reinstall. Without FileVault, anyone with physical access can reinstall macOS over the top.

We've chosen to keep FV on and automate around the friction. The next two sections do that.

### Pre-login SSH gotchas

- It only accepts **password** auth. Your beautiful Secure Enclave SSH keys do NOT work for the unlock step — only for normal SSH after boot. Verified empirically.
- It only works over **wired ethernet**. WiFi passwords live in a keychain that isn't unlocked yet.
- Both `cole` and `puddles` passwords work for the SSH disk unlock step. For the GUI login step in §11/§12, we always use puddles so puddles' LaunchAgents fire.

---

## 11. One-command unlock from your MacBook

This repo ships a script that does both unlock steps from your MacBook with a single password prompt.

### One-time setup on your MacBook

```bash
git clone <this-repo> ~/git/productivity-mcp-servers
cd ~/git/productivity-mcp-servers

# Install vncdotool to the SYSTEM python3 (not Homebrew python — the script
# pins /usr/bin/python3 because that's what's guaranteed to exist)
/usr/bin/python3 -m pip install --user vncdotool
```

### Per-reboot UX

```bash
~/git/productivity-mcp-servers/scripts/mac-mini/unlock.sh
# → "Enter puddles' macOS password:"
# → ~30 seconds later: "Done. puddles logged in."
```

The script:
1. SSHes to the FV pre-boot stub via `expect`, sends the password to unlock the disk. Aborts cleanly on bad password / timeout / permission denied (no marching on against a still-locked disk).
2. Waits for the real sshd to come back online.
3. Connects to the Mini's VNC at `192.168.8.230:5900` using **Apple ARD authentication** (Diffie-Hellman scheme 30 — macOS Screen Sharing offers ARD first in the auth list, before plain VNC).
4. Sleeps 8 seconds (the loginwindow needs about that long after VNC connect before the password field is reliably focused).
5. Types puddles' password character-by-character at 0.08s/char, presses Enter.
6. Disconnects. The GUI session persists for the entire uptime — subsequent VNC reconnects go straight to puddles' desktop.

The password is read once with `read -rs` (no echo), passed to subprocesses via env var (`$PW`), and never written to disk or shell history.

### Why we don't drive Screen Sharing.app via AppleScript

We tried. Focus race conditions caused the typed password to leak from the loginwindow into the foreground Terminal app. Raw RFB via vncdotool sends keystrokes directly over the VNC channel — there's no app focus involved, so the leak is structurally impossible.

---

## 12. One-tap unlock from your iPhone

Same architecture, different host: the Mini SSHes into **itself** to drive its own loginwindow. The phone never needs Python, vncdotool, a Shell app, or a VNC client — just SSH.

### One-time install on the Mini

```bash
# As puddles (via SSH)
git clone <this-repo> ~/git/productivity-mcp-servers
python3 -m pip install --user vncdotool

# As cole (sudo required to install to /usr/local/bin)
sudo mkdir -p /usr/local/bin
sudo install -m 0755 ~/git/productivity-mcp-servers/scripts/mac-mini/unlock-self.sh /usr/local/bin/unlock-self.sh
```

> **Note:** `/usr/local/bin/` doesn't exist on Apple Silicon macOS by default. The `mkdir -p` is required.

### One-time setup on your iPhone (Termius free tier)

1. Save a host: `puddles@coles-mac-mini-1`, password stored in Termius keychain (Face ID gated).
2. Create a Snippet named "Unlock Mini":
   - Body: `unlock-self.sh`
   - Toggle on: **"Close session after running"**

### Per-reboot UX

1. Power returns → wait ~30 seconds for the Mini to reach the FV pre-boot stub.
2. Open Termius → tap the saved host. Termius transparently sends the password to the FV pre-boot SSH stub, the disk unlocks, and Termius auto-reconnects to the real sshd ~45 seconds later (looks like one continuous session to you).
3. Tap the snippet "Unlock Mini".
4. Tap "Send Password" when the script prompts.
5. Snippet auto-closes. Done. Total: about three taps and a minute.

### Why this works

Once FileVault is unlocked, the Mini's sshd is fully running and accepts normal logins regardless of GUI state. The `unlock-self.sh` script connects to **`localhost::5900`** via Apple ARD auth and injects keystrokes into its own loginwindow. macOS doesn't care that the VNC keystroke source is the same machine.

### A note on UPS

A small UPS (~$80–150, e.g. APC Back-UPS 600VA or CyberPower CP685AVR) gets you 10–15 minutes of runtime. Most home power blips are under 30 seconds, so the UPS holds and the Mac Mini never reboots — zero unlocks needed. For long outages, the UPS triggers a clean shutdown and you do the two-step on the way back up. Drops your unplanned-unlock frequency from "every blip" to "once or twice a year" and protects the SSD from corruption on top of that. Recommended; not strictly required.

---

## 13. Automated weekly Homebrew updates

Tailscale's Homebrew install can't auto-update itself, and you don't want to be SSHing in to run `brew upgrade` by hand every week. This repo ships a system LaunchDaemon that does it for you.

### What's in the repo

- `scripts/mac-mini/brew-autoupdate.sh` — runs `brew update && brew upgrade && brew cleanup`, logging to `~/Library/Logs/brew-autoupdate.log`
- `scripts/mac-mini/com.cole.brew-autoupdate.plist` — system LaunchDaemon, fires Sundays at 03:00 local
- `scripts/mac-mini/install-brew-autoupdate.sh` — installs both with the right perms

### Install (as cole, on the Mini)

```bash
cd ~/git/productivity-mcp-servers
sudo ./scripts/mac-mini/install-brew-autoupdate.sh
```

### Validate

```bash
# Trigger immediately to confirm it works
sudo launchctl kickstart -k system/com.cole.brew-autoupdate
sleep 60
tail ~/Library/Logs/brew-autoupdate.log
# Expect to see "=== done @ ... ===" with a freed-disk-space line
```

### Why a system LaunchDaemon and not cron or a per-user LaunchAgent?

- **cron** still works on macOS but Apple's been deprecating it for years and it doesn't survive every macOS upgrade gracefully.
- **A per-user LaunchAgent under puddles** would fail with `Permission denied` writing to `/opt/homebrew` — that directory is owned by cole.
- **A system LaunchDaemon with `<key>UserName</key><string>cole</string>`** runs at boot regardless of who's logged in, executes as cole (so it can write to `/opt/homebrew`), and gets logging via the plist's `StandardOutPath` keys. This is the macOS-native answer.

The job runs at 03:00 — Apple Silicon doesn't restart for `brew upgrade`, so the Mini stays up. No FileVault dance needed.

---

## 14. iCloud backup convention

We accept full Mac wipes — but we want to never lose data we can't reproduce.

### The convention

Apply this to **every component** you install going forward:

| Path                       | Contents              | Backed up by      |
|----------------------------|-----------------------|-------------------|
| `~/git/<project>/`         | Code, install         | GitHub            |
| `~/Documents/<project>/`   | Runtime data, configs | iCloud Drive      |

Most modern tools support `--data-dir`, `XDG_DATA_HOME`, or an env var to redirect their data location. When you install something, point its data dir at `~/Documents/<project>/`. If a tool insists on `~/.thing/`, symlink: `ln -s ~/Documents/thing ~/.thing`.

### Sign puddles into iCloud

You'll need a GUI session for this — VNC in as puddles (do step 1 of §11/§12, then VNC in).

In **System Settings**:

1. Click **"Sign in with your Apple ID"** at the top of the sidebar → enter puddles' Apple ID + password → 2FA code from your phone.
2. **Apple Account → iCloud → "Saved to iCloud"** — toggle ON:
   - ✅ **iCloud Drive** → click ⓘ → toggle ON **"Desktop & Documents Folders"**
   - ✅ **Contacts**
   - ✅ **Calendars**
   - ✅ **Reminders**
   - ✅ **Notes**
   - ✅ **Messages in iCloud**
   - ✅ **Keychain**
   - ✅ **Find My Mac** (lets you locate/wipe if stolen)
   - ✅ **Photos** (only if you'll save anything to Photos)
   - ✅ **Mail** (only if using Mail.app)
   - ✅ **Safari** (optional)
3. **"Saved to this Mac" section** at the bottom: leave everything OFF — we want all of it in iCloud.

After flipping these, give it a few minutes. `~/Documents` and `~/Desktop` get moved into the iCloud container automatically. Verify:

```bash
ls -la ~/Documents
# Should show a path under ~/Library/Mobile Documents/com~apple~CloudDocs/Documents
```

That's it. From here on, any project that lives at `~/Documents/<project>/` is automatically backed up.

---

## 15. Verifying everything works

Run through this checklist. Every line should pass.

```bash
# From your MacBook on the home LAN
ssh puddles@192.168.8.230 'whoami && hostname'
# → puddles
# → Coles-Mac-mini

# From your MacBook over Tailscale (or your phone, anywhere in the world)
ssh puddles@coles-mac-mini-1 'whoami'
# → puddles  (Touch ID prompt should fire)

# From the Mini, as cole
sudo fdesetup list
# → both cole and puddles listed (FileVault enabled for both)

sudo launchctl list | grep tailscale
# → tailscale daemon present, exit status 0

sudo launchctl list | grep brew-autoupdate
# → com.cole.brew-autoupdate present

ls -la /Users/puddles/Documents
# → path under Mobile Documents (iCloud)

# From puddles via VNC, in System Settings → Apple Account → iCloud
# → Drive ON, Desktop & Documents ON, Messages in iCloud ON
```

The big test: **reboot the Mini** (`sudo shutdown -r now`), then unlock it from your iPhone using §12. It should take about a minute and three taps and end with you SSH'd into a fully-up puddles session.

---

## 16. Where to go next

You now have a hardened, headless, remotely-recoverable Mac Mini. From here:

- **Stop here** if you just wanted a home server. It's already useful — you can run any service that fits on macOS.
- **Continue to guide 02** to install OpenClaw and connect your first integrations.

The next guide (when written) will assume the state you have right now: two accounts, FileVault unlocked, Tailscale up, iCloud Drive backing up `~/Documents`.

---

## 17. Appendix: gotchas worth re-reading

These are the things that ate the most hours during the original build. If something isn't working, check here first.

1. **WiFi must be off** — pre-login SSH unlock requires ethernet. Period.
2. **FileVault + auto-login = impossible on Apple Silicon.** Don't fight it; use the two-step unlock.
3. **Pre-login SSH is password-only** — Touch ID / Secure Enclave keys do NOT work for the unlock step. They work fine for normal SSH after boot.
4. **Per-user LaunchAgents do NOT run after pre-login SSH unlock alone.** You need an actual GUI login (the VNC step) for them to fire.
5. **Tailscale: use Homebrew CLI, NOT App Store.** App Store version is sandboxed.
6. **Tailscale: use `sudo brew services start`, NOT plain `brew services start`.** Without sudo it's a per-user agent and won't run on a headless server.
7. **Tailscale: disable key expiry** for this device. Default 180 days will silently disconnect you.
8. **Secure Enclave SSH keys are ECDSA P-256, not Ed25519.** Apple's bundled OpenSSH doesn't support `ed25519-sk`.
9. **Loginwindow needs ~8 seconds after VNC connect** before the password field is reliably focused. Type too fast and keystrokes drop silently.
10. **macOS Screen Sharing offers Apple ARD auth (DH scheme 30) first in the auth list.** Generic VNC clients need a `username=` for it to work.
11. **`/usr/local/bin/` doesn't exist on Apple Silicon by default.** `sudo mkdir -p /usr/local/bin` first.
12. **Homebrew is owned by whoever installed it** (`/opt/homebrew` writable only by cole, since cole is admin). Auto-upgrade jobs MUST run as that user.
13. **HDMI dummy plug or `displayplacer`** — without one, Screen Sharing may inherit a 640×480 resolution from a "no monitor attached" boot.
14. **UniFi inter-VLAN port lists are quirky.** Safer to use one rule per port (or a port group with each port listed individually) than a comma-separated list or a range.
15. **Lock screen ON, even though headless.** Background services run regardless of lock state; the lock just protects the physical box.
16. **Never paste passwords into AI assistant sessions.** They get logged. Use Screen Sharing for sudo operations and Termius's Face-ID-gated keychain for the unlock password.

---

*This guide is the cleaned-up extract of [`docs/plans/016-openclaw-mac-mini-setup.md`](../plans/016-openclaw-mac-mini-setup.md), which contains the full construction history, alternative options considered, and additional lessons learned.*
