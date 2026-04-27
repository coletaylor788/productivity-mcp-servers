import { describe, it, expect, vi } from "vitest";
import type { CopilotLLMClient } from "../src/copilot-llm.js";
import type { ContactsTrustResolver } from "../src/contacts/contacts-trust.js";
import { ContactsEgressGuard } from "../src/egress/contacts-egress-guard.js";

function makeMockLLM() {
  return {
    classify: vi.fn(),
    destroy: vi.fn(),
  } as unknown as CopilotLLMClient & { classify: ReturnType<typeof vi.fn> };
}

function makeResolver(trusted: string[]): ContactsTrustResolver {
  const set = new Set(trusted.map((e) => e.toLowerCase()));
  return {
    isTrustedEmail: vi.fn(async (email: string) => set.has(email.toLowerCase())),
    healthCheck: vi.fn(),
  } as unknown as ContactsTrustResolver;
}

function classifyMock(secrets: boolean, sensitive: boolean) {
  return (_content: string, prompt: string) => {
    if (prompt.includes("secrets or credentials")) {
      return Promise.resolve(
        JSON.stringify({
          detected: secrets,
          evidence: secrets ? "secret found" : "",
        }),
      );
    }
    if (prompt.includes("financial or medical")) {
      return Promise.resolve(
        JSON.stringify({
          detected: sensitive,
          evidence: sensitive ? "sensitive found" : "",
        }),
      );
    }
    return Promise.resolve(JSON.stringify({ detected: false, evidence: "" }));
  };
}

describe("ContactsEgressGuard", () => {
  it("allows when every destination is in Contacts", async () => {
    const guard = new ContactsEgressGuard({
      contacts: makeResolver(["alice@example.com", "bob@example.com"]),
    });

    const result = await guard.check("send_email", "Hello", {
      to: "alice@example.com",
    });
    expect(result.action).toBe("allow");
  });

  it("blocks an untrusted single destination with action-oriented reason", async () => {
    const guard = new ContactsEgressGuard({
      contacts: makeResolver(["alice@example.com"]),
    });

    const result = await guard.check("send_email", "Hi", {
      to: "stranger@example.com",
    });
    expect(result.action).toBe("block");
    expect(result.reason).toContain("'stranger@example.com'");
    expect(result.reason).toContain("not an approved recipient");
    expect(result.reason).toContain("Ask the user to approve");
    // Must NOT name the trust mechanism.
    expect(result.reason?.toLowerCase()).not.toContain("contact");
    expect(result.reason?.toLowerCase()).not.toContain("address book");
  });

  it("blocks all untrusted destinations and lists them in the reason", async () => {
    const guard = new ContactsEgressGuard({
      contacts: makeResolver(["alice@example.com"]),
      extractDestinations: (_t, p) =>
        Array.isArray(p.recipients) ? (p.recipients as string[]) : [],
    });

    const result = await guard.check("send_email", "Hi", {
      recipients: ["alice@example.com", "stranger@x.com", "another@y.com"],
    });
    expect(result.action).toBe("block");
    expect(result.reason).toContain("stranger@x.com");
    expect(result.reason).toContain("another@y.com");
    expect(result.reason).not.toContain("alice@example.com");
    expect(result.reason).toContain("not approved");
  });

  it("trustedDomains short-circuits the resolver lookup", async () => {
    const resolver = makeResolver([]);
    const guard = new ContactsEgressGuard({
      contacts: resolver,
      trustedDomains: ["example.com"],
    });

    const result = await guard.check("send_email", "Hi", {
      to: "anyone@example.com",
    });
    expect(result.action).toBe("allow");
    expect(resolver.isTrustedEmail).not.toHaveBeenCalled();
  });

  it("trustedDomains tolerates leading @ and is case-insensitive", async () => {
    const guard = new ContactsEgressGuard({
      contacts: makeResolver([]),
      trustedDomains: ["@Example.COM"],
    });
    const result = await guard.check("send_email", "Hi", {
      to: "anyone@example.com",
    });
    expect(result.action).toBe("allow");
  });

  it("blocks on secrets in content (when classifiers enabled)", async () => {
    const llm = makeMockLLM();
    llm.classify.mockImplementation(classifyMock(true, false));
    const guard = new ContactsEgressGuard({
      contacts: makeResolver(["alice@example.com"]),
      llm,
    });

    const result = await guard.check("send_email", "my key is sk-abc", {
      to: "alice@example.com",
    });
    expect(result.action).toBe("block");
    expect(result.reason).toContain("Secrets detected");
  });

  it("blocks on sensitive in content even for trusted recipient", async () => {
    const llm = makeMockLLM();
    llm.classify.mockImplementation(classifyMock(false, true));
    const guard = new ContactsEgressGuard({
      contacts: makeResolver(["alice@example.com"]),
      llm,
    });

    const result = await guard.check("send_email", "salary info", {
      to: "alice@example.com",
    });
    expect(result.action).toBe("block");
    expect(result.reason).toContain("Sensitive data detected");
  });

  it("does not call classifiers when llm is not provided", async () => {
    const guard = new ContactsEgressGuard({
      contacts: makeResolver(["alice@example.com"]),
    });
    const result = await guard.check("send_email", "anything goes", {
      to: "alice@example.com",
    });
    expect(result.action).toBe("allow");
  });

  it("fails closed when the resolver is degraded (every dest untrusted)", async () => {
    const resolver = {
      isTrustedEmail: vi.fn(async () => false),
      healthCheck: vi.fn(),
    } as unknown as ContactsTrustResolver;
    const guard = new ContactsEgressGuard({ contacts: resolver });

    const result = await guard.check("send_email", "Hi", {
      to: "alice@example.com",
    });
    expect(result.action).toBe("block");
  });

  it("allows when no destinations are extracted (no recipients = no egress)", async () => {
    const guard = new ContactsEgressGuard({
      contacts: makeResolver([]),
      extractDestinations: () => [],
    });
    const result = await guard.check("calendar", "title", { title: "internal" });
    expect(result.action).toBe("allow");
  });

  it("normalizes destination case before checking", async () => {
    const guard = new ContactsEgressGuard({
      contacts: makeResolver(["alice@example.com"]),
    });
    const result = await guard.check("send_email", "Hi", {
      to: "Alice@Example.COM",
    });
    expect(result.action).toBe("allow");
  });
});
