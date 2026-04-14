import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { CopilotLLMClient } from "../src/copilot-llm.js";
import { TrustStore } from "../src/trust-store.js";
import { SendApproval } from "../src/egress/send-approval.js";

function makeMockLLM() {
  return {
    classify: vi.fn(),
    destroy: vi.fn(),
  } as unknown as CopilotLLMClient & { classify: ReturnType<typeof vi.fn> };
}

function makeClassifyResponse(secrets: boolean, sensitive: boolean, pii: boolean) {
  return (content: string, prompt: string) => {
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
    if (prompt.includes("personally identifiable")) {
      return Promise.resolve(
        JSON.stringify({
          detected: pii,
          evidence: pii ? "PII found" : "",
        }),
      );
    }
    return Promise.resolve(JSON.stringify({ detected: false, evidence: "" }));
  };
}

describe("SendApproval", () => {
  let llm: ReturnType<typeof makeMockLLM>;
  let trustStore: TrustStore;
  let sendApproval: SendApproval;
  let tempDir: string;

  beforeEach(() => {
    llm = makeMockLLM();
    tempDir = mkdtempSync(join(tmpdir(), "send-approval-test-"));
    trustStore = new TrustStore({
      pluginId: "test-send",
      extractDestination: (_tool, params) => (params.to as string) ?? null,
      storageDir: tempDir,
    });
    sendApproval = new SendApproval({ llm, trustStore });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("secrets always block", () => {
    it("should block secrets regardless of trust level (unknown)", async () => {
      llm.classify.mockImplementation(makeClassifyResponse(true, false, false));

      const result = await sendApproval.check("send_email", "has secrets", {
        to: "stranger@example.com",
      });

      expect(result.action).toBe("block");
      expect(result.reason).toContain("Secrets detected");
      expect(result.approval).toBeUndefined();
    });

    it("should block secrets regardless of trust level (trusted)", async () => {
      trustStore.trust("friend@example.com");
      llm.classify.mockImplementation(makeClassifyResponse(true, false, false));

      const result = await sendApproval.check("send_email", "has secrets", {
        to: "friend@example.com",
      });

      expect(result.action).toBe("block");
      expect(result.reason).toContain("Secrets detected");
    });
  });

  describe("sensitive always blocks", () => {
    it("should block sensitive data regardless of trust level", async () => {
      trustStore.trust("friend@example.com");
      llm.classify.mockImplementation(makeClassifyResponse(false, true, false));

      const result = await sendApproval.check("send_email", "salary info", {
        to: "friend@example.com",
      });

      expect(result.action).toBe("block");
      expect(result.reason).toContain("Sensitive data detected");
    });
  });

  describe("PII behavior depends on trust", () => {
    it("should block PII to unknown with approval request", async () => {
      llm.classify.mockImplementation(makeClassifyResponse(false, false, true));

      const result = await sendApproval.check("send_email", "phone number", {
        to: "stranger@example.com",
      });

      expect(result.action).toBe("block");
      expect(result.reason).toContain("PII detected");
      expect(result.approval).toBeDefined();
      expect(result.approval!.severity).toBe("warning");
    });

    it("should block PII to approved with approval request", async () => {
      trustStore.approve("known@example.com");
      llm.classify.mockImplementation(makeClassifyResponse(false, false, true));

      const result = await sendApproval.check("send_email", "phone number", {
        to: "known@example.com",
      });

      expect(result.action).toBe("block");
      expect(result.approval).toBeDefined();
    });

    it("should allow PII to trusted destination", async () => {
      trustStore.trust("trusted@example.com");
      llm.classify.mockImplementation(makeClassifyResponse(false, false, true));

      const result = await sendApproval.check("send_email", "phone number", {
        to: "trusted@example.com",
      });

      expect(result.action).toBe("allow");
      expect(result.classification!.has_personal).toBe(true);
    });
  });

  describe("clean content behavior", () => {
    it("should block clean content to unknown with approval (new destination)", async () => {
      llm.classify.mockImplementation(
        makeClassifyResponse(false, false, false),
      );

      const result = await sendApproval.check("send_email", "Hello!", {
        to: "newperson@example.com",
      });

      expect(result.action).toBe("block");
      expect(result.reason).toBe("Unknown destination");
      expect(result.approval).toBeDefined();
      expect(result.approval!.severity).toBe("info");
      expect(result.approval!.title).toContain("newperson@example.com");
    });

    it("should allow clean content to approved destination", async () => {
      trustStore.approve("known@example.com");
      llm.classify.mockImplementation(
        makeClassifyResponse(false, false, false),
      );

      const result = await sendApproval.check("send_email", "Hello!", {
        to: "known@example.com",
      });

      expect(result.action).toBe("allow");
    });

    it("should allow clean content to trusted destination", async () => {
      trustStore.trust("friend@example.com");
      llm.classify.mockImplementation(
        makeClassifyResponse(false, false, false),
      );

      const result = await sendApproval.check("send_email", "Hello!", {
        to: "friend@example.com",
      });

      expect(result.action).toBe("allow");
    });
  });

  describe("approval metadata", () => {
    it("should include destination in approval title for PII", async () => {
      llm.classify.mockImplementation(makeClassifyResponse(false, false, true));

      const result = await sendApproval.check("send_email", "SSN 123-45-6789", {
        to: "stranger@example.com",
      });

      expect(result.approval).toBeDefined();
      expect(result.approval!.title).toContain("unknown");
    });

    it("should include destination in approval title for new destination", async () => {
      llm.classify.mockImplementation(
        makeClassifyResponse(false, false, false),
      );

      const result = await sendApproval.check("send_email", "Hi", {
        to: "first-time@example.com",
      });

      expect(result.approval!.title).toContain("first-time@example.com");
    });
  });

  describe("multiple destinations", () => {
    it("should use resolveAll for array of recipients", async () => {
      trustStore.trust("a@example.com");
      // b is unknown
      llm.classify.mockImplementation(
        makeClassifyResponse(false, false, false),
      );

      const result = await sendApproval.check("send_email", "Hello", {
        recipients: ["a@example.com", "b@example.com"],
      });

      // Because b is unknown, overall trust should be unknown → block
      expect(result.action).toBe("block");
      expect(result.trustLevel).toBe("unknown");
    });
  });

  describe("classification result", () => {
    it("should include classification in result", async () => {
      llm.classify.mockImplementation(makeClassifyResponse(false, true, true));

      const result = await sendApproval.check("send_email", "content", {
        to: "test@example.com",
      });

      expect(result.classification).toBeDefined();
      expect(result.classification!.has_secrets).toBe(false);
      expect(result.classification!.has_sensitive).toBe(true);
      expect(result.classification!.has_personal).toBe(true);
    });
  });
});
