# Plan 014: Egress Approval Plugin

**Status:** Draft  
**Created:** 2026-04-13  
**Depends on:** Plan 009 (MCP Security Hooks Library), Plan 013 (OpenClaw Plugins Scaffold)

## Summary

Build an OpenClaw plugin (`openclaw-plugins/egress-approval/`) that wraps ContentGuard (from Plan 009) with an interactive approval flow. When the agent tries to send content to an unknown or partially-trusted destination, the user is prompted to approve or deny — with trust building over time.

This plugin is the **approval handler** that sits between the raw hooks library (Plan 009) and the user. Other plugins (Plan 010 Gmail, Plan 012 web providers) wire ContentGuard into their tool execution, and this plugin provides the approval UX and trust persistence.

## How It Fits

```
Plan 009: ContentGuard.check() → returns classification + trust level
                ↓
Plan 014: This plugin → triggers requireApproval, manages trust store
                ↓
Plans 010/012: MCP + web plugins → call ContentGuard in their execute() wrappers
```

ContentGuard (009) is a pure function: content in → classification out. This plugin (014) adds the interactive layer: approval prompts, tapback shortcuts, trust list persistence.

## Two-Tier Trust Model

| Trust Level | Can message? | Can send PII? |
|---|---|---|
| **unknown** | ❌ Needs approval | ❌ Needs approval |
| **approved** | ✅ | ❌ Needs approval |
| **trusted** | ✅ | ✅ |

Secrets and sensitive data are **always blocked** regardless of trust level.

## Approval UX

Two UX paths work simultaneously:

### Tapback Shorthand (iMessage via BlueBubbles)

- 👍 on the approval message → `allow-once` (let this send through)
- 👎 on the approval message → `deny` (block it)

### Text Commands (all channels)

- `/approve <id> allow-once` → let this send through, don't remember
- `/approve <id> allow-always` → send + upgrade this **destination's** trust tier
- `/approve <id> deny` → block it

### `allow-always` Behavior

`allow-always` is **scoped to the destination**, not the tool:

| Current tier | `allow-always` effect |
|---|---|
| unknown | → **approved** (can message, PII still blocked) |
| approved + PII flagged | → **trusted** (can message + PII) |
| trusted | no change |

The ContentGuard check is never globally disabled.

## Tapback Translation

The plugin registers a `message_received` hook that translates iMessage tapback reactions into approval decisions:

```typescript
api.on("message_received", async (event) => {
  if (!event.replyToId || !isTapback(event.text)) return;
  
  const approvalId = pendingApprovals.get(event.replyToId);
  if (!approvalId) return;
  
  const decision = isPositiveTapback(event.text) ? "allow-once" : "deny";
  await api.requestGateway("plugin.approval.resolve", { approvalId, decision });
});
```

This uses OpenClaw's existing `plugin.approval.resolve` gateway method — same codepath as the `/approve` text command. Both UX paths converge at the same resolution handler.

## Approval Flow

```
send_email(to: "vendor@partner.org", body: "...")
  │
  ├── ContentGuard.check() → { has_personal: true, trustLevel: "unknown" }
  │
  ├── Trust level unknown + any content → requireApproval
  │     User sees: "🛡️ New destination: vendor@partner.org"
  │     User 👍 → allow-once (send, don't remember)
  │     User types /approve abc12 allow-always → approve destination
  │
  └── Next send to vendor@partner.org with PII:
        Trust level approved + PII detected → requireApproval
        User sees: "🛡️ PII detected — vendor@partner.org not trusted for personal info"
        User types /approve def34 allow-always → upgrade to trusted
```

## Trust Store Integration

This plugin uses `TrustStore` from Plan 009 for persistence and resolution. Each consuming plugin (Gmail, Slack, etc.) creates its own `TrustStore` instance with plugin-specific destination extraction:

```typescript
// Gmail plugin creates its TrustStore
const trustStore = new TrustStore({
  pluginId: "secure-gmail",
  extractDestination: (toolName, params) => params.to as string,
});

// This plugin's approval handler calls trustStore methods on resolution
trustStore.handleApprovalDecision(destination, decision);
```

Storage: `~/.openclaw/trust/{pluginId}.json`

## Plugin Structure

```
openclaw-plugins/
└── egress-approval/
    ├── openclaw.plugin.json
    ├── plugin.ts              # Registers before_tool_call + message_received hooks
    ├── package.json
    ├── tsconfig.json
    └── src/
        ├── approval-handler.ts    # requireApproval logic + onResolution
        └── tapback-bridge.ts      # message_received → plugin.approval.resolve
```

## Plugin Manifest

```json
{
  "id": "egress-approval",
  "name": "Egress Approval & Trust",
  "version": "0.1.0",
  "description": "Interactive approval for outbound tool calls with trust building",
  "configSchema": {
    "type": "object",
    "properties": {
      "timeoutMs": {
        "type": "number",
        "description": "Approval timeout in milliseconds",
        "default": 300000
      },
      "timeoutBehavior": {
        "type": "string",
        "enum": ["allow", "deny"],
        "default": "deny"
      }
    }
  }
}
```

## Resolved Questions

**Approval message ID tracking:** `PluginHookMessageSentEvent` doesn't expose `messageId`. Workaround: the approval message contains a unique approval ID (e.g., `abc12345`) in its content. On `message_sent`, match content containing the approval ID → store `conversationId → approvalId` mapping. On `message_received` with a tapback in the same conversation, resolve the pending approval. Since there's only one pending approval per conversation at a time, conversation-level matching is sufficient — no message ID needed.

**Multi-recipient emails:** All recipients must meet the trust threshold. If sending to 3 recipients where 2 are trusted and 1 is unknown, the approval triggers showing the untrusted recipient(s). `allow-always` upgrades **all** listed recipients to the appropriate trust tier.

**Trust store ownership:** The egress-approval plugin owns all trust stores. Consuming plugins (secure-gmail, etc.) register their trust config at startup:

```typescript
// In secure-gmail plugin.ts
api.requestGateway("egress-approval.registerTrustStore", {
  pluginId: "secure-gmail",
  extractDestination: (toolName, params) => params.to,
  seedDomains: ["mycompany.com"],
  tools: ["send_email"],  // which tools this trust store applies to
});
```

The egress-approval plugin creates the `TrustStore` instance, manages persistence, handles approval decisions, and upgrades trust tiers. The consuming plugin never touches the trust store directly — it just provides the key extraction logic and tool list.

---

## Checklist

### Implementation
- [ ] Create `openclaw-plugins/egress-approval/` directory structure
- [ ] Write `openclaw.plugin.json` manifest
- [ ] Implement approval handler (ContentGuardResult → requireApproval)
- [ ] Implement tapback bridge (message_received → plugin.approval.resolve)
- [ ] Implement `allow-always` → trust tier upgrade in onResolution
- [ ] Wire approval message ID tracking for tapback matching

### Testing

**Unit tests (mocked dependencies, fast):**
- [ ] TrustStore.resolve() returns correct level for unknown/approved/trusted contacts
- [ ] TrustStore.resolve() falls back to domain matching
- [ ] Contact-level trust overrides domain-level
- [ ] `handleApprovalDecision("allow-always")` upgrades unknown → approved
- [ ] `handleApprovalDecision("allow-always")` upgrades approved → trusted (when PII flagged)
- [ ] `handleApprovalDecision("allow-once")` does not change trust store
- [ ] `handleApprovalDecision("deny")` does not change trust store
- [ ] Approval handler generates correct `requireApproval` for unknown destination
- [ ] Approval handler generates correct `requireApproval` for approved destination + PII
- [ ] No approval triggered for trusted destination + PII
- [ ] Secrets always blocked regardless of trust tier
- [ ] Tapback translation: 👍 → allow-once, 👎 → deny

**Integration tests (real Copilot API, requires PAT in keychain):**
- [ ] Full flow: unknown destination → approval → allow-always → contact saved as approved
- [ ] Full flow: approved destination + PII → approval → allow-always → contact upgraded to trusted
- [ ] Full flow: trusted destination + PII → no approval, passes through
- [ ] Full flow: secrets detected → hard block, no approval offered
- [ ] Trust store persists to disk and reloads correctly
- [ ] Seeded domains work on first run (no approvals needed for seeded domains)
- [ ] Tapback 👍 resolves pending approval correctly
- [ ] Tapback 👎 resolves pending approval correctly
- [ ] Timeout defaults to deny

### Documentation
- [ ] README.md with setup and UX guide
- [ ] Plan marked as complete with date
