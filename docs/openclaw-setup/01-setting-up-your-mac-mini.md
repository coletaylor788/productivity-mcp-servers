# Setting up your Mac Mini

This is the first guide in my journey building Puddles, my personal AI agent, on a Mac Mini. By the end of it you'll have a hardened, headless server you can manage from your phone or laptop — the foundation everything else gets built on top of.

The work here isn't strictly OpenClaw-specific. If you stop after this guide and never install an agent, you still end up with a securely run always-on home server you can use for anything. Worth doing on its own.

A few things you'll come away with:

- A Mac Mini that runs **without a monitor, keyboard, or mouse**
- **Two accounts** with clean separation: an admin you almost never log into, and a "service" account that runs everything
- An **encrypted disk** (FileVault) you can unlock remotely after a power outage from your phone or laptop in about three taps
- **SSH gated by Touch ID** on your other Apple devices, with no exportable private keys anywhere
- **Tailscale** for zero-config secure access from anywhere in the world
- Network isolation on its own VLAN
- **Automated weekly software updates** for installed packages
- **iCloud-backed runtime data** so a full Mac wipe never costs you anything you care about

Security is the throughline. A lot of the choices below go beyond the out-of-the-box Apple defaults — sometimes substantially — because the goal is defense in depth for a machine that'll eventually run autonomous agentic workflows on your behalf.

> **Time:** about half a day, mostly waiting on FileVault to encrypt and software to install.
> **Skill:** comfortable with home networking and firewall configuration.

---

## Table of contents

1. [Hardware](#1-hardware)
2. [Traditional Security Model](#2-traditional-security-model)
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

## 1. Hardware

- **Mac Mini M4** (any Apple Silicon Mac will work; this guide is written for the M4 base model)
- Wired ethernet to your home router or switch

---

## 2. Traditional Security Model

### What I'm defending against

- **Physical theft** — encrypted disk, owner-credential-required recovery
- **Lateral movement from other devices on the home network** — VLAN isolation
- **Internet attackers** — no inbound ports forwarded; everything through Tailscale
- **The agent itself getting compromised** (e.g. via prompt injection) — separate identity, standard user

### Compromises

- **A frictionless reboot.** FileVault is on, which means a power outage requires a quick unlock dance instead of a clean auto-login. Worth the tradeoff.

### Key design choices and their reasons

| Choice                                              | Why                                                                                                 |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Two accounts (admin + standard)                     | Compromise of the agent doesn't give attacker sudo. Admin has no personal data to exfiltrate.       |
| Admin has no Apple ID                               | Attack surface reduction — no iCloud, no Keychain sync, nothing personal on that account            |
| FileVault on                                        | Defense in depth on top of the always-on Apple Silicon hardware encryption                          |
| Tailscale                                           | Authenticated VPN access from anywhere without forwarding any ports                                 |
| Tailscale ACLs: agent CANNOT reach personal devices | Limits blast radius if the agent is compromised                                                     |
| Lock screen on, even though headless                | Background services run regardless of lock state; lock protects the physical box if anyone walks up |
| Puddle's files stored in iCloud                     | Free, automatic backup of `~/Documents` so a wipe is recoverable                                    |

### Logical Layout

Two principles drive everything inside the box:

- **Account isolation.** An admin account owns system-level changes (Homebrew, `sudo`, network/sharing toggles). A separate standard account (`puddles`) runs all the actual workloads — agent processes, background services, anything autonomous. The agent account **cannot `sudo`**. If it's ever compromised, the blast radius is one user's home directory, not the whole machine.
- **Encryption at rest.** Disk is FileVault-encrypted to protect data against physical theft.

```
                    ┌─────────────────────────────┐
                    │   Mac Mini M4 (headless)    │
                    │  Encrypted disk (FileVault) │
                    │                             │
        Manage      │  cole (admin)               │
   ────────────────►│   - rarely logged in        │
                    │   - no Apple ID             │
                    │   - owns Homebrew           │
                    │                             │
    Daily use as    │  puddles (standard user)    │
    the agent ────► │   - has its own Apple ID    │
                    │   - runs all services       │
                    │   - cannot sudo             │
                    │                             │
                    │  System LaunchDaemons       │
                    │   - Tailscale (always on)   │
                    │   - brew autoupdate (Sun)   │
                    └─────────────────────────────┘
                                  │
                                  │  iCloud Drive
                                  ▼
                          puddles' Apple ID
                            (data backup)
```

### Network architecture

The network is the first layer of defense, designed around these principles:

- **No ingress from the internet.** Tailscale provides remote access without any port forwarding.
- **Recoverable from anywhere after an unexpected restart.** A planned second path (Tailscale on the UDM itself) covers the window before FileVault is unlocked, when the Mini's own Tailscale daemon hasn't started yet.
- **Agent isolated from the rest of the internal network.** Inbound from Trusted VLAN is restricted to SSH only; outbound from the Agent VLAN to anything else is dropped.

```
                       ┌─────────────────────────┐
                       │       My devices        │
                       │       (anywhere)        │
                       │     MacBook  iPhone     │
                       └──────┬─────────────┬────┘
                              │             │
                  via         │             │  Planned: Tailscale in UDM
                  Tailscale   │             │  
                              │             │
   ┌──────────────────────────┘             │
   │                                        │
   │                                        ▼
   │          ╔════════════════════════════════════════════════════════╗
   │          ║                     HOME NETWORK                       ║
   │          ║                                                        ║
   │          ║                ┌──────────────────┐                    ║
   │          ║                │  UDM (gateway)   │                    ║
   │          ║                └────────┬─────────┘                    ║
   │          ║                         │                              ║
   │          ║         ┌───────────────┼─────────────────┐            ║
   │          ║         ▼               ▼                 ▼            ║
   │          ║   ┌─────────┐       ┌──────────┐       ┌──────────┐    ║
   │          ║   │ Trusted │  22   │  Agent   │       │  Other   │    ║
   │          ║   │  VLAN   │   ✓   │  VLAN    │   ✗   │  VLANs   │    ║
   │          ║   │         │─────► │          │─────► │ (IoT,    │    ║
   │          ║   │         │◄───── │ Mac Mini │◄───── │  guest)  │    ║
   │          ║   │         │   ✗   │          │   ✗   │          │    ║
   │          ║   └─────────┘       └────┬─────┘       └──────────┘    ║
   │          ║                          │                             ║
   │          ║                          │                             ║
   │          ║                          │                             ║
   │          ║                          ▼                             ║
   │          ╚══════════════════════════╪═════════════════════════════╝
   │                                     │
   │                                     ▼
   │                      ┌─────────────────────────────┐
   └─────────────────────►│          Tailscale          │
                          └─────────────────────────────┘
```

#### Two paths in

Because Tailscale doesn't run until FileVault is unlocked, after an unexpected reboot you need a **second path** to reach the box on the LAN:

| Path                                       | When to use                         | Works pre-FileVault-unlock? |
| ------------------------------------------ | ----------------------------------- | --------------------------- |
| Tailscale → `<mac-mini-tailnet-name>`      | Day-to-day management from anywhere | ❌                           |
| Trusted VLAN → Mini's reserved LAN IP      | Unlocking after power loss, at home | ✅                           |
| Tailscale VPN into the UDM → Mini's LAN IP | Unlocking after power loss, away    | ✅  (planned)                |

---

## 3. What you need before starting

**On the Mac Mini:**
- macOS 26 (Tahoe) or newer — this guide depends on Tahoe's pre-login SSH unlock feature
- Wired ethernet

**On your other gear:**
- A MacBook on the same LAN you'll use for setup
- An iPhone (we'll use Termius, free tier)
- A UniFi Dream Machine (or any router that supports VLANs — instructions are UDM-specific but adapt easily)
- A password manager you trust (this guide assumes Apple Passwords for the FileVault recovery key — anything works)

**Two Apple IDs ready:**
- One for **puddles** (the agent account) — we'll sign into iCloud with this. This is not the same as your own apple id.
- The admin (**cole**) intentionally does NOT use an Apple ID

**Names used throughout this guide** (substitute your own):
- Admin user: **cole**
- Service user: **puddles**
- Hostname: `<mac-mini>` — pick something short, lowercase, and memorable; the same name will become the device's tailnet name
- LAN IP: `<mini-lan-ip>` — whatever you reserve in your router's DHCP for the Mini
- VLAN for the Mini: I'll just call it **Agent VLAN** in this guide. Name it whatever you like in your UniFi controller.

---

## 4. Initial macOS install and accounts

1. Boot the Mac Mini, complete Apple's Setup Assistant.
2. **Don't sign into any Apple ID** when prompted. Skip it. (We'll sign puddles into iCloud later, in §14.)
3. Create the **first user as `cole`**, set as admin. Use a strong password
4. After reaching the desktop, open **System Settings → Users & Groups** and create a second user **`puddles`**, type **Standard** (not Administrator). Strong password.
5. Run software updates: **System Settings → General → Software Update**. Apply everything, reboot, repeat until clean.

**Why no Apple ID on cole:** if puddles is ever compromised and the attacker pivots to root, there's no Keychain or iCloud account on the admin account to exfiltrate.

---

## 5. Network: VLAN, ethernet, hostname

### On the UniFi controller

1. Create a new isolated VLAN for the Mini (call it whatever you want; this guide refers to it as the **Agent VLAN**). Pick a subnet that doesn't overlap your other VLANs.
2. Add a **firewall rule**: traffic from the Agent VLAN → all other VLANs = **Drop**. (Default-deny outbound from the agent network.)
3. Add a **firewall rule**: traffic from your Trusted VLAN → Agent VLAN, allow TCP `22` (SSH). That's the only inter-VLAN port you need — VNC for the FileVault unlock is invoked locally on the Mini against `localhost`, and Tailscale traffic rides its own encrypted overlay (it doesn't traverse the inter-VLAN firewall path).
4. Add a **firewall rule** *below* the SSH allow (rule order matters in UniFi — first match wins): traffic from any other VLAN → Agent VLAN = **Drop**. This catches everything that isn't the Trusted-VLAN-to-SSH carve-out above. Without this rule, IoT and guest devices can reach the Mini on every other port by default.
5. Plug the Mac Mini into a switch port assigned to the Agent VLAN.
6. Wait for the Mini to get an IP, then create a **DHCP reservation** for it. Note the reserved IP — you'll use it as `<mini-lan-ip>` throughout the rest of the guide.

### On the Mac Mini (logged in as cole)

```bash
# Set the hostname (otherwise it'll be something like "Mac-mini-2" with a random suffix).
# Pick something short, lowercase, and memorable. It becomes the tailnet name too.
HOST=mac-mini
sudo scutil --set HostName "$HOST"
sudo scutil --set LocalHostName "$HOST"
sudo scutil --set ComputerName "$HOST"
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

---

## 7. SSH with Secure Enclave keys (Touch ID)

It is useful to enable coding agents to run commands via SSH on your mac mini. To avoid exposing any credentials to the context and session logs of your agents, you can setup secure enclave keys so the agent can issue SSH commands and you just have to touch your fingerprint (no key exposed to agent).

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
ssh cole@<mini-lan-ip>
ssh puddles@<mini-lan-ip>
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
ssh puddles@<mac-mini>   # works from any tailnet device (use whatever you named the device on Tailscale)
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

> **Important:** Homebrew is **owned by whoever installed it.** `/opt/homebrew` ends up writable by cole and ONLY cole. Anything that runs `brew upgrade` later (including the autoupdate job in §13) MUST run as cole. The system LaunchDaemon in §13 handles that by running as the cole user.

---

## 10. FileVault and the two-step unlock model

### Enable FileVault

On the Mini (you'll need physical/VNC access for this, since it requires interactive prompts as both users):

1. **System Settings → Privacy & Security → FileVault → Turn On**
2. When prompted, enable BOTH `cole` and `puddles` as FileVault users (both must be secure-token holders).
3. **Recovery key:** store it in your password manager.
4. Wait for encryption to finish (can take an hour or more on first run).

Verify both users are enabled:
```bash
sudo fdesetup list
# Should show both cole and puddles
```

### What happens after a reboot — read this carefully

This is the part of headless macOS that is tricky. After a reboot, FileVault halts the boot process at a pre-login stub. Two distinct things have to happen before the box is "really" running:

**Step 1 — Disk unlock (FileVault).** SSH to the Mini. The connection itself triggers the FileVault unlock — the disk decrypts and boot continues.

After step 1, you have:
- ✅ Disk decrypted
- ✅ macOS booted
- ✅ **System LaunchDaemons running** (Tailscale, sshd, the brew autoupdate timer)
- ❌ **No user logged in** — the box is parked at the loginwindow
- ❌ **Per-user LaunchAgents NOT running** (Messages.app, anything needing the Apple ID Keychain, the agent itself once it's installed)

**Step 2 — GUI login.** A VNC client connects to the loginwindow and types puddles' password into the password field. NOW puddles' user session exists, his LaunchAgents fire, and the system is fully operational.

### Why auto-login isn't an option

On Apple Silicon, **GUI auto-login is impossible while FileVault is on**. Both the System Settings GUI and `sysadminctl -autologin set` refuse with: *"Automatic login is disabled because FileVault is enabled"*. This isn't a bug; it's by design.

This matters more than it looks. The GUI login step (§11/§12) isn't just cosmetic — anything that runs as a per-user LaunchAgent or needs the user's GUI session to exist is dead until puddles is logged in. **BlueBubbles**, the iMessage bridge a later guide installs, is a hard example: it depends on Messages.app actually running in puddles' GUI session, which only happens after a real loginwindow login. So the unlock automation in §11/§12 isn't optional polish — it's what makes anything GUI-bound work after a reboot.

### Why not use auto-login?

With auto-login on, anyone who physically steals the device could plug it in and boot directly into `puddles` account, accessing much of the data the agent can access.

### Pre-login SSH gotchas

- It only accepts **password** auth. Your beautiful Secure Enclave SSH keys do NOT work for the unlock step — only for normal SSH after boot. Verified empirically.
- It only works over **wired ethernet**. WiFi passwords live in a keychain that isn't unlocked yet.
- Both `cole` and `puddles` passwords work for the SSH disk unlock step. For the GUI login step in §11/§12, always use puddles so puddles' LaunchAgents fire.

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
3. Connects to the Mini's VNC at `<mini-lan-ip>:5900` using **Apple ARD authentication** (Diffie-Hellman scheme 30 — macOS Screen Sharing offers ARD first in the auth list, before plain VNC).
4. Sleeps 8 seconds (the loginwindow needs about that long after VNC connect before the password field is reliably focused).
5. Types puddles' password character-by-character at 0.08s/char, presses Enter.
6. Disconnects. The GUI session persists for the entire uptime — subsequent VNC reconnects go straight to puddles' desktop.

The password is read once with `read -rs` (no echo), passed to subprocesses via env var (`$PW`), and never written to disk or shell history.

---

## 12. One-tap unlock from your iPhone

Same architecture, different host: the Mini SSHes into **itself** to drive its own loginwindow. The phone just needs SSH.

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

1. Save a host: `puddles@<mac-mini>` (your tailnet name), password stored in Termius.
2. Create a Snippet named "Unlock Mini":
   - Body: `unlock-self.sh`

### What to do if the Mini reboots unexpectedly

1. Open Termius → tap the saved host. Termius transparently sends the password to the FV pre-boot SSH stub, the disk unlocks, and Termius connects.
2. Tap the snippet "Unlock Mini".
3. Tap "Password", then "Enter" when the script prompts.
4. Wait for script to run.

### Why this works

Once FileVault is unlocked, the Mini's sshd is fully running and accepts normal logins regardless of GUI state. The `unlock-self.sh` script connects to **`localhost::5900`** via Apple ARD auth and injects keystrokes into its own loginwindow. macOS doesn't care that the VNC keystroke source is the same machine.

### A note on UPS

Adding a UPS should protect against most unexpected restarts. Though being able to re-enable your agent when traveling or on the go is an important backup.

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


---

## 14. iCloud backup convention

I accept that the entire OS install can be lost — but I want to never lose data that can't be reproduced from code or APIs.

### The convention

Apply this to every component you install going forward:

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
ssh puddles@<mini-lan-ip> 'whoami && hostname'
# → puddles
# → <your-hostname>

# From your MacBook over Tailscale (or your phone, anywhere in the world)
ssh puddles@<mac-mini> 'whoami'
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

The next guide (when written) assumes the state you have right now: two accounts, FileVault on with both users enabled, Tailscale up, and iCloud Drive backing up `~/Documents`.

---

## 17. Appendix: gotchas worth re-reading

These are all the obstacles I hit getting a secure Mac server running, here's to hoping you don't have to.

1. **Must use Ethernet** — pre-login SSH unlock requires ethernet. Period.
2. **Pre-login SSH is password-only** — Touch ID / Secure Enclave keys do NOT work for the unlock step. They work fine for normal SSH after boot.
3. **Per-user LaunchAgents do NOT run after pre-login SSH unlock alone.** You need an actual GUI login (the VNC step) for them to fire.
4. **Tailscale: use `sudo brew services start`, NOT plain `brew services start`.** Without sudo it's a per-user agent and won't run on a headless server.
5. **Tailscale: disable key expiry** for this device. Default 180 days will silently disconnect you.
6. **Secure Enclave SSH keys are ECDSA P-256, not Ed25519.** Apple's bundled OpenSSH doesn't support `ed25519-sk`.
7. **Loginwindow needs ~8 seconds after VNC connect** before the password field is reliably focused. Type too fast and keystrokes drop silently.
8. **macOS Screen Sharing offers Apple ARD auth (DH scheme 30) first in the auth list.** Generic VNC clients need a `username=` for it to work.
9. **`/usr/local/bin/` doesn't exist on Apple Silicon by default.** `sudo mkdir -p /usr/local/bin` first.
10. **Homebrew is owned by whoever installed it** (`/opt/homebrew` writable only by cole, since cole is admin). Auto-upgrade jobs MUST run as that user.
11. **UniFi inter-VLAN port lists are quirky.** Safer to use one rule per port (or a port group with each port listed individually) than a comma-separated list or a range.
12. **Lock screen ON, even though headless.** Background services run regardless of lock state; the lock just protects the physical box.
13. **Never paste passwords into AI assistant sessions.** Yeah, it's inconvenient, but these sessions are not designed or secured the same way secret managers are. Execute your own SSH commands for sudo operations and use secure enclave for SSH the agent can execute.