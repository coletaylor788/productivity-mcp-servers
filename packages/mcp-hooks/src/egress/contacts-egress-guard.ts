import type { CopilotLLMClient } from "../copilot-llm.js";
import type { EgressHook, HookResult } from "../types.js";
import { classifyBoolean } from "../classify.js";
import { SECRETS_PROMPT, SENSITIVE_PROMPT } from "../prompts.js";
import type { ContactsTrustResolver } from "../contacts/contacts-trust.js";

/**
 * Pulls destination identifiers (typically email addresses) out of a tool
 * call's params. Receives the unparsed `toolName` so a single extractor can
 * route across multiple tool shapes if needed.
 */
export type ExtractDestinations = (
  toolName: string,
  params: Record<string, unknown>,
) => string[];

/**
 * Egress hook backed by iCloud Contacts as the trust list.
 *
 * Decision flow per call:
 *   1. If `content` contains secrets → block.
 *   2. If `content` contains sensitive data → block.
 *   3. For every destination from `extractDestinations`:
 *        - email domain in `trustedDomains` → trusted
 *        - email in resolver's AddressBook → trusted
 *        - else → untrusted
 *      If any destination is untrusted → block, naming the offenders.
 *   4. Otherwise → allow.
 *
 * Block reason is action-oriented and names the offending recipient(s) but
 * never names the trust mechanism (no "contacts", no "address book", no
 * "add them" instructions). The agent learns *who* to flag and *that*
 * approval is human-gated — not *how*. When the user says "yes, add them,"
 * the agent reaches for `contact create` because that's the natural tool.
 *
 * Fail-closed: if the resolver can't read Contacts, every destination is
 * untrusted (effectively block-all until repaired). The classifier path
 * fails open (matches LeakGuard behavior).
 */
export class ContactsEgressGuard implements EgressHook {
  private readonly contacts: ContactsTrustResolver;
  private readonly trustedDomains: ReadonlySet<string>;
  private readonly extractDestinations: ExtractDestinations;
  private readonly llm?: CopilotLLMClient;
  private readonly runContentClassifiers: boolean;

  constructor(opts: ContactsEgressGuardOptions) {
    this.contacts = opts.contacts;
    this.trustedDomains = normalizeDomains(opts.trustedDomains);
    this.extractDestinations =
      opts.extractDestinations ?? defaultExtractDestinations;
    this.llm = opts.llm;
    this.runContentClassifiers = opts.runContentClassifiers ?? Boolean(opts.llm);
  }

  async check(
    toolName: string,
    content: string,
    params?: Record<string, unknown>,
  ): Promise<HookResult> {
    if (this.runContentClassifiers && this.llm && content.length > 0) {
      const [secrets, sensitive] = await Promise.all([
        classifyBoolean(this.llm, content, SECRETS_PROMPT, "contacts-egress.secrets"),
        classifyBoolean(this.llm, content, SENSITIVE_PROMPT, "contacts-egress.sensitive"),
      ]);
      if (secrets.outcome === "ok" && secrets.detected) {
        return {
          action: "block",
          reason: `Secrets detected: ${secrets.evidence}`,
        };
      }
      if (sensitive.outcome === "ok" && sensitive.detected) {
        return {
          action: "block",
          reason: `Sensitive data detected: ${sensitive.evidence}`,
        };
      }
    }

    const destinations = this.extractDestinations(toolName, params ?? {})
      .map((d) => d.trim().toLowerCase())
      .filter((d) => d.length > 0);

    if (destinations.length === 0) {
      return { action: "allow" };
    }

    const untrusted: string[] = [];
    for (const dest of destinations) {
      if (this.isDomainTrusted(dest)) continue;
      const ok = await this.contacts.isTrustedEmail(dest);
      if (!ok) untrusted.push(dest);
    }

    if (untrusted.length === 0) {
      return { action: "allow" };
    }

    return {
      action: "block",
      reason: formatBlockReason(untrusted),
    };
  }

  private isDomainTrusted(email: string): boolean {
    if (this.trustedDomains.size === 0) return false;
    const at = email.lastIndexOf("@");
    if (at === -1) return false;
    return this.trustedDomains.has(email.slice(at + 1));
  }
}

export interface ContactsEgressGuardOptions {
  /** Trust resolver (iCloud Contacts). */
  contacts: ContactsTrustResolver;
  /**
   * Email domains to auto-trust without consulting Contacts (e.g. the user's
   * own organization). Case-insensitive; leading "@" tolerated.
   */
  trustedDomains?: Iterable<string>;
  /**
   * Extract destination strings from tool params. Defaults to common email
   * field names (`to`/`recipient`/`recipients`/`email`/`address`).
   */
  extractDestinations?: ExtractDestinations;
  /**
   * If provided, runs secrets + sensitive content classifiers on the egress
   * content before checking destinations. PII classifier is intentionally
   * dropped — it only existed to drive the old approval-escalation ladder.
   */
  llm?: CopilotLLMClient;
  /** Default: true if `llm` is provided. Set false to disable classifiers. */
  runContentClassifiers?: boolean;
}

const defaultExtractDestinations: ExtractDestinations = (_toolName, params) => {
  for (const key of ["to", "recipient", "recipients", "email", "address"]) {
    const val = params[key];
    if (typeof val === "string") return [val];
    if (Array.isArray(val)) {
      return val.filter((v): v is string => typeof v === "string");
    }
  }
  return [];
};

function normalizeDomains(domains: Iterable<string> | undefined): Set<string> {
  const out = new Set<string>();
  if (!domains) return out;
  for (const d of domains) {
    const norm = d.trim().toLowerCase().replace(/^@/, "");
    if (norm.length > 0) out.add(norm);
  }
  return out;
}

function formatBlockReason(untrusted: string[]): string {
  if (untrusted.length === 1) {
    return `Recipient '${untrusted[0]}' is not an approved recipient. Ask the user to approve before retrying.`;
  }
  return `The following recipients are not approved: ${untrusted
    .map((r) => `'${r}'`)
    .join(
      ", ",
    )}. Ask the user to approve before retrying.`;
}
