# Plan 012: Secure Web Provider Plugins

**Status:** Draft  
**Created:** 2026-04-12  
**Depends on:** Plan 009 (MCP Security Hooks Library), Plan 013 (OpenClaw Plugins Scaffold)

## Summary

Build OpenClaw provider plugins that replace the built-in `web_fetch` and `web_search` implementations with hook-secured versions. These plugins use `api.registerWebFetchProvider()` and `api.registerWebSearchProvider()` to intercept all web content flowing into the agent, applying InjectionGuard (from Plan 009) to detect prompt injection.

## Context: Why Provider Replacement

- `web_fetch` and `web_search` run on the **host gateway**, not inside Docker containers
- Provider replacement swaps the implementation behind the built-in tool name, avoiding name collisions
- These tools pull content from the open internet — high-risk ingress vectors for prompt injection

## Architecture

```
OpenClaw
  │
  ├── loads secure-web plugin
  │     │
  │     ├── registerWebFetchProvider("secure-fetch")
  │     │     └── createTool() returns execute() that:
  │     │           1. Performs the actual HTTP fetch
  │     │           2. InjectionGuard (ingress) — scan response
  │     │           3. Returns content or blocks
  │     │
  │     └── registerWebSearchProvider("secure-search")
  │           └── createTool() returns execute() that:
  │                 1. Performs the actual web search
  │                 2. InjectionGuard (ingress) — scan results
  │                 3. Returns results or blocks
  │
  └── agent calls web_fetch / web_search as normal (security is transparent)
```

## Plugin Structure

```
openclaw-plugins/
└── secure-web/
    ├── openclaw.plugin.json
    ├── plugin.ts
    ├── package.json
    ├── tsconfig.json
    ├── src/
    │   ├── secure-fetch-provider.ts
    │   └── secure-search-provider.ts
    └── tests/
        └── plugin.test.ts
```

## Configuration

### Plugin Manifest (`openclaw.plugin.json`)
```json
{
  "id": "secure-web",
  "name": "Secure Web Providers",
  "version": "0.1.0",
  "description": "Replaces built-in web_fetch and web_search with injection-guarded versions",
  "configSchema": {
    "type": "object",
    "properties": {
      "model": {
        "type": "string",
        "description": "LLM model for injection analysis",
        "default": "claude-haiku-4.5"
      },
      "egressChecks": {
        "type": "boolean",
        "description": "Enable LeakGuard on URLs and search queries (blocks PII/secrets in outbound queries)",
        "default": false
      }
    }
  }
}
```

### OpenClaw Config (to activate)
```json
{
  "plugins": {
    "load": {
      "paths": ["~/git/productivity-mcp-servers/openclaw-plugins/secure-web"]
    },
    "entries": {
      "secure-web": {
        "config": {
          "model": "claude-haiku-4.5"
        }
      }
    }
  },
  "tools": {
    "web": {
      "fetch": { "provider": "secure-fetch" },
      "search": { "provider": "secure-search" }
    }
  }
}
```

## Implementation

### Plugin Entry Point

```typescript
// plugin.ts
import { InjectionGuard, LeakGuard, CopilotLLMClient } from "mcp-hooks";
import { createSecureFetchProvider } from "./src/secure-fetch-provider";
import { createSecureSearchProvider } from "./src/secure-search-provider";

export default {
  id: "secure-web",

  register(api) {
    const config = api.pluginConfig ?? {};
    const llm = new CopilotLLMClient({ model: config.model ?? "claude-haiku-4.5" });
    
    const injectionGuard = new InjectionGuard({ llm });
    const leakGuard = config.egressChecks ? new LeakGuard({ llm }) : null;

    api.registerWebFetchProvider(
      createSecureFetchProvider({ injectionGuard, leakGuard })
    );
    api.registerWebSearchProvider(
      createSecureSearchProvider({ injectionGuard, leakGuard })
    );
  },
};
```

### Secure Fetch Provider

```typescript
// src/secure-fetch-provider.ts
export function createSecureFetchProvider({ injectionGuard, leakGuard }) {
  return {
    id: "secure-fetch",
    label: "Secure Web Fetch",
    hint: "Fetches pages with prompt injection detection.",
    envVars: [],
    placeholder: "",
    signupUrl: "",
    credentialPath: "plugins.entries.secure-web.config.enabled",
    getCredentialValue: () => true,
    setCredentialValue: () => {},

    createTool: (ctx) => ({
      description: "Fetch a web page with injection scanning.",
      parameters: {
        url: { type: "string", description: "The URL to fetch" },
        max_length: { type: "number", description: "Maximum content length" },
        raw: { type: "boolean", description: "Return raw HTML instead of markdown" },
        start_index: { type: "number", description: "Start index for pagination" },
      },

      async execute(args) {
        // EGRESS (optional): check URL for leaked PII/secrets
        if (leakGuard) {
          const egress = await leakGuard.check("web_fetch", JSON.stringify(args));
          if (egress.action === "block") {
            return { content: [{ type: "text", text: `⚠️ Blocked: ${egress.reason}` }] };
          }
        }

        // Perform the actual fetch
        const rawContent = await doFetch(args);

        // INGRESS: injection guard on response
        const result = await injectionGuard.check("web_fetch", rawContent);
        if (result.action === "block") {
          return { content: [{ type: "text", text: `⚠️ Blocked: ${result.reason}` }] };
        }
        return { content: [{ type: "text", text: rawContent }] };
      },
    }),
  };
}
```

### Secure Search Provider

Same pattern — `injectionGuard.check()` on search results, optional `leakGuard.check()` on the query.

## Egress Considerations

- **web_fetch URL**: Could leak internal URLs or embed PII. Optional via `egressChecks: true`.
- **web_search query**: Could contain sensitive context from the conversation. Optional via `egressChecks: true`.
- **Default**: Ingress only (InjectionGuard). Egress is opt-in.

The async global injection guard (Plan 011) provides a safety net for all other tools including x_search via `after_tool_call`. When we're ready for dedicated x_search coverage, we build our own plugin that calls the xAI API directly and wraps it with hooks — same pattern as secure-gmail.

---

## Checklist

### Implementation
- [ ] Create `openclaw-plugins/secure-web/` directory structure
- [ ] Write `openclaw.plugin.json` manifest
- [ ] Write `package.json` with mcp-hooks dependency
- [ ] Write `tsconfig.json`
- [ ] Implement `src/secure-fetch-provider.ts` with InjectionGuard
- [ ] Implement `src/secure-search-provider.ts` with InjectionGuard
- [ ] Write `plugin.ts` entry point with provider registration
- [ ] Implement `doFetch()` helper (Node fetch + readability extraction)
- [ ] Implement `doSearch()` helper (search backend delegation)
- [ ] Add optional LeakGuard egress support

### Testing

**Unit tests (mocked dependencies, fast):**
- [ ] Secure fetch provider calls InjectionGuard on fetched content
- [ ] Secure search provider calls InjectionGuard on search results
- [ ] InjectionGuard block returns error with reason
- [ ] Clean content passes through unmodified
- [ ] Optional LeakGuard blocks PII in search queries when enabled
- [ ] Optional LeakGuard blocks PII in fetch URLs when enabled
- [ ] LeakGuard disabled by default (no egress check without config)
- [ ] `doFetch()` handles HTTP errors gracefully
- [ ] `doSearch()` handles search API errors gracefully

**Integration tests (mocked LLM, real plugin wiring):**
- [ ] Plugin loads correctly in OpenClaw
- [ ] Provider registration succeeds for both web_fetch and web_search
- [ ] Full flow: fetched page with injection → blocked
- [ ] Full flow: search results with injection → blocked
- [ ] Full flow: clean web page → passes through
- [ ] Full flow: egress check blocks query containing SSN (when enabled)

### Cleanup
- [ ] Code linting passes
- [ ] No unused imports or dead code

### Documentation
- [ ] README.md with setup instructions
- [ ] Plan marked as complete with date
