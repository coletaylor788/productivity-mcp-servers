import type { CopilotLLMClient } from "../copilot-llm.js";
import type { SendApprovalResult, TrustLevel, ContentClassification } from "../types.js";
import type { TrustStore } from "../trust-store.js";
import { classifyBoolean } from "../classify.js";
import { SECRETS_PROMPT, SENSITIVE_PROMPT, PII_PROMPT } from "../prompts.js";

/**
 * Function that pulls destination identifiers (typically email addresses) out
 * of a tool call's params. Used to look up trust levels and to surface to the
 * user in the approval prompt. Receives the unparsed `toolName` so a single
 * extractor can route across multiple tool shapes if needed.
 */
export type ExtractDestinations = (
  toolName: string,
  params: Record<string, unknown>,
) => string[];

export class SendApproval {
  private llm: CopilotLLMClient;
  private trustStore: TrustStore;
  private extractDestinationsImpl: ExtractDestinations;

  constructor(options: {
    llm: CopilotLLMClient;
    trustStore: TrustStore;
    /**
     * Override the built-in destination extractor. The built-in only knows
     * about `to`/`recipient`/`recipients`/`email`/`address` — provide a custom
     * extractor for tools that nest destinations elsewhere (e.g. calendar
     * `attendees: [{ email }]`).
     */
    extractDestinations?: ExtractDestinations;
  }) {
    this.llm = options.llm;
    this.trustStore = options.trustStore;
    this.extractDestinationsImpl =
      options.extractDestinations ?? defaultExtractDestinations;
  }

  async check(
    toolName: string,
    content: string,
    params?: Record<string, unknown>,
  ): Promise<SendApprovalResult> {
    // Extract destinations from params and resolve their combined trust level
    const destinations = this.extractDestinationsImpl(toolName, params ?? {});
    const trustLevel = destinations.length > 0
      ? this.trustStore.resolveAll(destinations)
      : "unknown" as TrustLevel;

    // Run classification in parallel via the shared helper
    const [secrets, sensitive, pii] = await Promise.all([
      classifyBoolean(this.llm, content, SECRETS_PROMPT),
      classifyBoolean(this.llm, content, SENSITIVE_PROMPT),
      classifyBoolean(this.llm, content, PII_PROMPT),
    ]);

    const classification: ContentClassification = {
      has_secrets: secrets.outcome === "ok" && secrets.detected,
      has_sensitive: sensitive.outcome === "ok" && sensitive.detected,
      has_personal: pii.outcome === "ok" && pii.detected,
    };

    // Secrets and sensitive: always block (when LLM returned a valid response)
    if (classification.has_secrets) {
      return {
        action: "block",
        reason: `Secrets detected: ${secrets.evidence}`,
        classification,
        trustLevel,
        destination: destinations[0],
      };
    }
    if (classification.has_sensitive) {
      return {
        action: "block",
        reason: `Sensitive data detected: ${sensitive.evidence}`,
        classification,
        trustLevel,
        destination: destinations[0],
      };
    }

    // PII: depends on trust level
    if (classification.has_personal && trustLevel !== "trusted") {
      return {
        action: "block",
        reason: `PII detected: ${pii.evidence}`,
        classification,
        trustLevel,
        destination: destinations[0],
        approval: {
          title: `PII to ${trustLevel} destination`,
          description: `${pii.evidence} → ${destinations.join(", ")}`.slice(0, 256),
          severity: "warning",
        },
      };
    }

    // Unknown destination with clean content: still needs approval
    if (trustLevel === "unknown") {
      return {
        action: "block",
        reason: "Unknown destination",
        classification,
        trustLevel,
        destination: destinations[0],
        approval: {
          title: `New destination: ${destinations.join(", ")}`,
          description: "First time sending to this destination.",
          severity: "info",
        },
      };
    }

    return {
      action: "allow",
      classification,
      trustLevel,
      destination: destinations[0],
    };
  }
}

/** Default destination extractor — handles common email-tool param shapes. */
const defaultExtractDestinations: ExtractDestinations = (_toolName, params) => {
  for (const key of ["to", "recipient", "recipients", "email", "address"]) {
    const val = params[key];
    if (typeof val === "string") return [val];
    if (Array.isArray(val)) return val.filter((v): v is string => typeof v === "string");
  }
  return [];
};
