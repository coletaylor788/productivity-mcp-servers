# Plan 020 — Sandbox skill mirror for rw workspaces

**Status:** Draft, awaiting approval
**Owner:** cole + Copilot
**Related:** docs/openclaw-setup/03-openclaw-and-agent-sandboxing.md, docs/openclaw-setup/04-secure-gmail.md

## Problem

The OpenClaw agent on the mini can't read any bundled skill (e.g. `bluebubbles`)
from inside its sandbox, so it has no idea how to use channel features that
require skill content — for example sending iMessage attachments via
`message` with `action: "sendAttachment"`. We hit this concretely on
2026-05-02 when Puddles tried to send an image and gave up after the
sandboxed `read` tool refused
`/Users/puddles/.npm-global/lib/node_modules/openclaw/skills/bluebubbles/SKILL.md`
with `Path escapes sandbox root (~/.openclaw/workspace)`.

### Root cause

OpenClaw's prompt builder advertises **every** discovered skill (bundled,
managed, plugin-shipped, workspace) in the `<available_skills>` system
prompt block with their absolute paths and tells the agent
*"Use the read tool to load a skill's file when the task matches its
description."*

For bundled skills the path is under the npm-global install
(`~/.npm-global/lib/node_modules/openclaw/skills/<name>/SKILL.md`),
which is **outside** our sandbox workspace root.

OpenClaw has a built-in `syncSkillsToWorkspace` mirror that materializes
all skills into `<sandbox-workspace>/skills/` so they're sandbox-readable.
However it's gated:

```js
// dist/sandbox-B4e3wZhD.js
if (cfg.workspaceAccess !== "rw") {
  await syncSkillsToWorkspace({ ... });
}
```

…and the sync semantic is **wipe-and-rebuild**:

```js
// dist/workspace-Dbhccs54.js
await fsp.rm(targetSkillsDir, { recursive: true, force: true });
await fsp.mkdir(targetSkillsDir, { recursive: true });
for (const entry of entries) await fsp.cp(entry.skill.baseDir, dest, { recursive: true });
```

In rw mode the sandbox uses the user's real workspace directly, so a
wipe-and-rebuild would silently destroy hand-authored skills (we already
have `~/.openclaw/workspace/skills/email-triage/`). The skip is
deliberate, but the prompt builder doesn't compensate — the agent still
gets unreachable paths in its prompt.

### Why the obvious workarounds don't work

| Approach | Verdict |
|---|---|
| `openclaw skills install <slug>` | ClawHub-only; bluebubbles isn't on ClawHub as a usage skill (the same name is taken by an unrelated dev/build skill). |
| `agents.X.skills` filter | Hides skills, doesn't change paths. |
| `skills.load.extraDirs` | Adds source dirs but they're loaded *before* `bundled` and `workspace` in `loadSkillEntries`, so they don't override the bundled record's path. |
| `sandbox.docker.binds` | Mount changes container view, but `loadSkillEntries` runs on the host and the prompt path is host-resolved — bind mounts don't change what the host loader emits. |
| Symlinks under `<workspace>/skills/<name>` | Verified blocked: `Skipping escaped skill path outside its configured root: reason=symlink-escape`. Hardened in upstream per CHANGELOG. |
| Switch to `workspaceAccess: "ro"` | Breaks every persistent file the agent writes (TODO.md, MEMORY.md, projects/, recipes/). |

The only safe path is to copy bundled skill **files** into
`<workspace>/skills/<name>/` ourselves, with no-clobber semantics so
hand-authored skills stay safe.

## Approach

A small idempotent mirror script + LaunchAgent on the mini that mirrors
eligible bundled (and plugin-shipped) skills into
`~/.openclaw/workspace/skills/`, preserving any hand-authored skills.

### Mirror script: `scripts/mac-mini/mirror-openclaw-skills.sh`

Behavior:

1. Source roots scanned (in order; first hit wins per skill name):
   - `~/.npm-global/lib/node_modules/openclaw/skills/` (bundled)
   - For each enabled plugin in `~/.openclaw/openclaw.json` `plugins.entries`,
     check `<plugin dist>/openclaw.plugin.json` for a `skills` array;
     mirror those too. (None of our current plugins ship skills, but we
     get this for free for the future.)

2. Destination: `~/.openclaw/workspace/skills/<skill-name>/`

3. **No-clobber by default**: if `<workspace>/skills/<name>/` exists
   *without* a `.openclaw-mirror` marker file, skip it (treated as
   user-authored). Log a one-line note.

4. **Refresh marker-owned dirs**: if the dir exists *with* a
   `.openclaw-mirror` marker, compare a content fingerprint
   (`openclaw --version` + `find <src> -type f -exec sha256sum`) against
   the one stored in the marker; if different, `rsync -a --delete`
   replace.

5. After copying, write `.openclaw-mirror` containing:
   ```
   source: <absolute source dir>
   openclaw_version: <openclaw --version output>
   fingerprint: <sha256 of file contents>
   mirrored_at: <ISO timestamp>
   ```

6. **Garbage collect**: remove any `<workspace>/skills/<name>/` that has
   our marker but whose source no longer exists (e.g. skill removed
   upstream).

7. Exit 0 always (best-effort), log issues to stderr.

8. PATH-safe (homebrew node may live at `/opt/homebrew/bin/node`).

Logs to `~/.openclaw/logs/skills-mirror.log` (line-prefixed timestamps).

### LaunchAgent: `scripts/mac-mini/ai.openclaw.skills-mirror.plist`

- `Label`: `ai.openclaw.skills-mirror`
- `UserName`: `puddles` (the gateway runs as puddles, so this needs to
  match)
- `RunAtLoad`: true (so login + reboot triggers a refresh)
- `StartInterval`: 21600 (6h periodic refresh)
- `WatchPaths`: `/Users/puddles/.npm-global/lib/node_modules/openclaw`
  (so a `pnpm i -g openclaw@latest` triggers a refresh within seconds)
- `StandardOutPath` / `StandardErrorPath`:
  `/Users/puddles/.openclaw/logs/skills-mirror.launchd.{out,err}`
- Mirror script absolute path baked in; lives at
  `/usr/local/bin/mirror-openclaw-skills.sh` after install.

### Installer: `scripts/mac-mini/install-openclaw-skills-mirror.sh`

Same pattern as `install-brew-autoupdate.sh`:
- `cp` script to `/usr/local/bin/`
- `cp` plist to `~/Library/LaunchAgents/`
- `launchctl bootstrap gui/$(id -u) <plist>`
- Run mirror once synchronously to populate before the agent starts

### Gateway integration

Run the mirror **once before** the gateway starts each time. Simplest
hook: edit `~/Library/LaunchAgents/ai.openclaw.gateway.plist` to
prepend a `ProgramArguments` shim, OR the cleaner alternative — make
the LaunchAgent's `RunAtLoad` + `WatchPaths` enough on its own (the
6h interval + watch covers most cases; on a fresh boot the gateway
might race the mirror, but it'd self-correct on the next interval).

I'll start with the LaunchAgent only (no gateway plist edit). If we
see startup race issues we can add a `--ensure-mirror` flag to the
gateway start script later.

### Documentation

Add a new section to `docs/openclaw-setup/03-openclaw-and-agent-sandboxing.md`:
**"§ Bundled skill access from the sandbox (rw mode)"** explaining the
gap, the no-clobber mirror approach, install command, and how to verify.
Cross-link from `04-secure-gmail.md` § *iMessage attachments via
BlueBubbles* (NEW) showing the agent the canonical recipe (reading the
skill is the source of truth, but a one-paragraph reminder helps).

### Upstream issue

File against OpenClaw with title:
*"Bundled skills unreachable in rw-workspace sandboxes — agent receives
read instruction with paths outside sandbox root"*

Suggest: in rw mode, additively mirror bundled skills into
`<workspace>/skills/<name>/` only when the destination dir doesn't
already exist (no wipe, no overwrite of hand-authored skills). Same
no-clobber semantic as our local script — but as a first-class feature
so users in rw mode aren't stuck.

## Out of scope

- Sandbox image rebuild (rsvg-convert, ImageMagick, pip, npm, etc.) —
  separate upcoming plan for the agent-can't-install-packages problem.
- Dropping the phantom `image` and `apply_patch` and `cron` entries from
  the main agent's allowlist — also belongs to that follow-up plan.
- Adding `KeyringError` handling to gmail-mcp `_keychain_get_token` —
  unrelated papercut from the JSON-prefilter session.

## Validation

After installing on the mini:

1. `ls ~/.openclaw/workspace/skills/` shows `email-triage` (preserved)
   and one dir per ready bundled skill (`bluebubbles`, etc.).
2. `cat ~/.openclaw/workspace/skills/bluebubbles/.openclaw-mirror`
   shows the marker.
3. `openclaw skills info bluebubbles` shows
   `Path: ~/.openclaw/workspace/skills/bluebubbles/SKILL.md`
   (workspace path, not npm-global path).
4. Restart the gateway, ask Puddles via iMessage to send a test image.
   The agent should `read skills/bluebubbles/SKILL.md`, learn the
   `sendAttachment` API, and successfully attach a file.
5. Check audit: `~/.openclaw/logs/secure-*-audit.jsonl` shows no new
   findings/errors.
6. Manually delete `<workspace>/skills/bluebubbles/`, run mirror again
   → re-created. Touch `<workspace>/skills/email-triage/SKILL.md`,
   run mirror → `email-triage` mtime unchanged (no clobber).

## Risks & mitigations

- **Race at first boot**: gateway starts before mirror finishes. The
  agent would see stale skills for one prompt cycle. Mitigation:
  installer runs mirror synchronously before bootstrapping the
  LaunchAgent. Acceptable.
- **OpenClaw upgrade changes skill format**: refresh-on-version-change
  via the marker fingerprint catches it.
- **User adds a skill named the same as a bundled skill**: mirror would
  refuse to overwrite it (no marker = treated as user-authored).
  Documented — user keeps full control.
- **Marker file leaks into prompt**: `.openclaw-mirror` starts with `.`
  which `loadSkillsFromDirSafe` already skips.

---

## Checklist

### Implementation

- [ ] Create `scripts/mac-mini/mirror-openclaw-skills.sh`
- [ ] Create `scripts/mac-mini/ai.openclaw.skills-mirror.plist`
- [ ] Create `scripts/mac-mini/install-openclaw-skills-mirror.sh`
- [ ] Local lint/shellcheck the bash scripts (no new tooling)
- [ ] Manually test mirror script on the mini via `--dry-run` flag

### Deployment

- [ ] `git push`
- [ ] Pull on mini, run installer
- [ ] Verify `<workspace>/skills/` populated (validation steps 1–3)
- [ ] Restart gateway via `launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway`

### Behavioral validation

- [ ] Ask Puddles to send a test image via iMessage; confirm it works
      (validation step 4)
- [ ] Inspect audit logs for clean findings (validation step 5)
- [ ] Run no-clobber test (validation step 6)

### Documentation

- [ ] Add §  to `docs/openclaw-setup/03-openclaw-and-agent-sandboxing.md`
- [ ] Add iMessage-attachments paragraph to `docs/openclaw-setup/04-secure-gmail.md`
      (or its successor — confirm the right home before writing)
- [ ] Update root `README.md` mention of mac-mini scripts if it lists them

### Upstream

- [ ] Open issue against OpenClaw repo with title above
- [ ] Link issue back into this plan as resolved-when

### Cleanup

- [ ] Mark plan complete with date
- [ ] Commit + push
