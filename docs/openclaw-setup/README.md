# OpenClaw Setup Guides

These are step-by-step guides from my journey building and running "Puddles", my personal AI agent, on a Mac Mini.

These are reference docs you can follow with no prior context — at every step of the way, security is kept as the highest priority. You'll file many creative solutions going beyond the OOB all aimed at ensuring defense in depth security while enabling complex autonomous agentic workflows.

## Guides

1. **[Setting up your Mac Mini](./01-setting-up-your-mac-mini.md)** — go from a factory Mac Mini to a securely hardened, headless, server. Stop here and you have an always-on home server even if you never install OpenClaw.
2. **[Talking to Puddles on iMessage](./02-talking-to-puddles-on-imessage.md)** — wire the Mini to iMessage via BlueBubbles, get the gateway running as a LaunchDaemon, and add a 15-minute self-heal loop.
3. **[OpenClaw and agent sandboxing](./03-openclaw-and-agent-sandboxing.md)** — install OpenClaw, split Puddles into four agents (`main`, `debug`, `reader`, `browser-agent`), drop the riskier ones inside Docker sandboxes, harden each `AGENTS.md` for adversarial input, and put every credential behind a `SecretRef`.
4. **[Wiring Gmail securely](./04-secure-gmail.md)** — install `gmail-mcp` against a delegated Google account, migrate the gateway from a LaunchDaemon to a LaunchAgent so it can read the login keychain, install the `secure-gmail` plugin so every Gmail response goes through `InjectionGuard` + `SecretRedactor` ingress hooks before the agent sees it, and wire audit logging.
5. _(coming later)_ Apple PIM (Calendar, Reminders, Contacts)

## Background

The canonical living plan is [`docs/plans/016-openclaw-mac-mini-setup.md`](../plans/016-openclaw-mac-mini-setup.md). The plan is the working scratchpad (what we're doing, why, lessons learned as we hit them). The guides in this folder are the cleaned-up, "do this and it works" version distilled out of the plan.
