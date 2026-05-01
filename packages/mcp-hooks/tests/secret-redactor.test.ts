import { describe, it, expect, vi, beforeEach } from "vitest";
import type { CopilotLLMClient } from "../src/copilot-llm.js";
import { SecretRedactor } from "../src/ingress/secret-redactor.js";

function makeMockLLM() {
  return {
    classify: vi.fn(),
    destroy: vi.fn(),
  } as unknown as CopilotLLMClient & { classify: ReturnType<typeof vi.fn> };
}

describe("SecretRedactor", () => {
  let llm: ReturnType<typeof makeMockLLM>;
  let redactor: SecretRedactor;

  beforeEach(() => {
    llm = makeMockLLM();
    redactor = new SecretRedactor({ llm });
    // Default: LLM finds nothing additional
    llm.classify.mockResolvedValue(JSON.stringify({ findings: [] }));
  });

  describe("regex phase - API keys", () => {
    it("should redact sk-proj- API keys", async () => {
      const content =
        "My key is sk-proj-abcdefghijklmnopqrstuvwxyz1234567890";
      const result = await redactor.check("read_email", content);

      expect(result.action).toBe("modify");
      expect(result.content).toContain("[REDACTED:api_key]");
      expect(result.content).not.toContain("sk-proj-");
      expect(result.details?.findingTypes).toContain("api_key");
      expect(result.details?.findingCount).toBeGreaterThanOrEqual(1);
    });

    it("should redact sk- style keys", async () => {
      const content =
        "Key: sk-abcdefghijklmnopqrstuvwxyz1234567890";
      const result = await redactor.check("read_email", content);

      expect(result.action).toBe("modify");
      expect(result.content).toContain("[REDACTED:api_key]");
    });
  });

  describe("regex phase - GitHub tokens", () => {
    it("should redact ghp_ tokens", async () => {
      const content =
        "Token: ghp_abcdefghijklmnopqrstuvwxyz1234567890ab";
      const result = await redactor.check("read_email", content);

      expect(result.action).toBe("modify");
      expect(result.content).toContain("[REDACTED:github_token]");
      expect(result.content).not.toContain("ghp_");
    });

    it("should redact github_pat_ tokens", async () => {
      const content =
        "PAT: github_pat_abcdefghijklmnopqrstuvwxyz12";
      const result = await redactor.check("read_email", content);

      expect(result.action).toBe("modify");
      expect(result.content).toContain("[REDACTED:github_token]");
    });
  });

  describe("regex phase - AWS keys", () => {
    it("should redact AWS access keys (AKIA...)", async () => {
      const content = "AWS Key: AKIAIOSFODNN7EXAMPLE";
      const result = await redactor.check("read_email", content);

      expect(result.action).toBe("modify");
      expect(result.content).toContain("[REDACTED:aws_key]");
      expect(result.content).not.toContain("AKIA");
    });
  });

  describe("regex phase - JWT tokens", () => {
    it("should redact JWT tokens", async () => {
      const content =
        "Token: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
      const result = await redactor.check("read_email", content);

      expect(result.action).toBe("modify");
      expect(result.content).toContain("[REDACTED:jwt]");
      expect(result.content).not.toContain("eyJ");
    });
  });

  describe("regex phase - Private keys", () => {
    it("should redact RSA private keys", async () => {
      const content = `Here is the key:
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEA0Z3VS5JJcds3xfn/ygWep4PAtGoLFt0mPbQWMn3KNkdG1Q5H
-----END RSA PRIVATE KEY-----
End of key.`;
      const result = await redactor.check("read_email", content);

      expect(result.action).toBe("modify");
      expect(result.content).toContain("[REDACTED:private_key]");
      expect(result.content).not.toContain("BEGIN RSA PRIVATE KEY");
    });

    it("should redact generic private keys", async () => {
      const content = `-----BEGIN PRIVATE KEY-----
MIIEvgIBADANBgkqhkiG9w0BAQ
-----END PRIVATE KEY-----`;
      const result = await redactor.check("read_email", content);

      expect(result.action).toBe("modify");
      expect(result.content).toContain("[REDACTED:private_key]");
    });
  });

  describe("regex phase - Connection strings", () => {
    it("should redact postgres connection strings", async () => {
      const content = "DB: postgres://user:pass@localhost:5432/mydb";
      const result = await redactor.check("read_email", content);

      expect(result.action).toBe("modify");
      expect(result.content).toContain("[REDACTED:connection_string]");
      expect(result.content).not.toContain("postgres://");
    });

    it("should redact mongodb connection strings", async () => {
      const content =
        "Mongo: mongodb+srv://admin:secret@cluster0.abc.mongodb.net/app";
      const result = await redactor.check("read_email", content);

      expect(result.action).toBe("modify");
      expect(result.content).toContain("[REDACTED:connection_string]");
    });
  });

  describe("regex phase - Bearer tokens", () => {
    it("should redact Bearer tokens", async () => {
      const content = "Authorization: Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.test.sig";
      const result = await redactor.check("read_email", content);

      expect(result.action).toBe("modify");
      // Could be redacted as bearer_token or jwt depending on pattern order
      expect(
        result.content!.includes("[REDACTED:bearer_token]") ||
          result.content!.includes("[REDACTED:jwt]"),
      ).toBe(true);
    });
  });

  describe("regex phase - Reset links", () => {
    it("should redact password reset links with tokens", async () => {
      const content =
        "Click here: https://app.example.com/reset-password?token=abc123def456ghi789jkl";
      const result = await redactor.check("read_email", content);

      expect(result.action).toBe("modify");
      expect(result.content).toContain("[REDACTED:reset_link]");
      expect(result.content).not.toContain("abc123def456");
    });
  });

  describe("regex phase - 2FA codes", () => {
    it("should redact 2FA codes", async () => {
      const content = "Your verification code: 847291";
      const result = await redactor.check("read_email", content);

      expect(result.action).toBe("modify");
      expect(result.content).toContain("[REDACTED:2fa_code]");
      expect(result.content).not.toContain("847291");
    });

    it("should redact verification codes", async () => {
      const content = "Verification code: 123456";
      const result = await redactor.check("read_email", content);

      expect(result.action).toBe("modify");
      expect(result.content).toContain("[REDACTED:2fa_code]");
    });
  });

  describe("regex phase - SSN", () => {
    it("should redact Social Security Numbers", async () => {
      const content = "SSN: 123-45-6789";
      const result = await redactor.check("read_email", content);

      expect(result.action).toBe("modify");
      expect(result.content).toContain("[REDACTED:ssn]");
      expect(result.content).not.toContain("123-45-6789");
    });
  });

  describe("regex phase - Credit cards", () => {
    it("should redact credit card numbers", async () => {
      const content = "Card: 4111 1111 1111 1111";
      const result = await redactor.check("read_email", content);

      expect(result.action).toBe("modify");
      expect(result.content).toContain("[REDACTED:credit_card]");
      expect(result.content).not.toContain("4111");
    });

    it("should redact credit cards with dashes", async () => {
      const content = "Card: 4111-1111-1111-1111";
      const result = await redactor.check("read_email", content);

      expect(result.action).toBe("modify");
      expect(result.content).toContain("[REDACTED:credit_card]");
    });
  });

  describe("regex phase - Multiple secrets", () => {
    it("should redact multiple secrets in one text", async () => {
      const content = `
        AWS Key: AKIAIOSFODNN7EXAMPLE
        SSN: 123-45-6789
        Card: 4111 1111 1111 1111
        Code: 847291
      `;
      const result = await redactor.check("read_email", content);

      expect(result.action).toBe("modify");
      expect(result.content).toContain("[REDACTED:aws_key]");
      expect(result.content).toContain("[REDACTED:ssn]");
      expect(result.content).toContain("[REDACTED:credit_card]");
      expect(result.content).toContain("[REDACTED:2fa_code]");
    });
  });

  describe("clean content", () => {
    it("should allow clean content without modification", async () => {
      const content =
        "Hello, just wanted to follow up on the meeting scheduled for Thursday.";
      const result = await redactor.check("read_email", content);

      expect(result.action).toBe("allow");
      expect(result.content).toBeUndefined();
    });
  });

  describe("LLM phase", () => {
    it("should redact additional secrets found by LLM", async () => {
      llm.classify.mockResolvedValue(
        JSON.stringify({
          findings: [
            { secret: "hunter2", type: "password" },
          ],
        }),
      );

      const content = "The password is hunter2, please don't share it.";
      const result = await redactor.check("read_email", content);

      expect(result.action).toBe("modify");
      expect(result.content).toContain("[REDACTED:password]");
      expect(result.content).not.toContain("hunter2");
    });

    it("should skip LLM findings not present in content (hallucination protection)", async () => {
      llm.classify.mockResolvedValue(
        JSON.stringify({
          findings: [
            { secret: "this-string-is-not-in-the-content", type: "api_key" },
          ],
        }),
      );

      const content =
        "Just a normal email about the project update for next week.";
      const result = await redactor.check("read_email", content);

      // Content has no regex matches and LLM finding isn't in content → allow
      expect(result.action).toBe("allow");
    });

    it("should return regex-only results on LLM failure", async () => {
      llm.classify.mockRejectedValue(new Error("LLM unavailable"));

      const content = "SSN: 123-45-6789 and the password is hunter2";
      const result = await redactor.check("read_email", content);

      expect(result.action).toBe("modify");
      // Regex should have caught the SSN
      expect(result.content).toContain("[REDACTED:ssn]");
      // But LLM-based "hunter2" detection would have failed
      expect(result.content).toContain("hunter2");
    });

    it("should return regex-only results on malformed LLM JSON", async () => {
      llm.classify.mockResolvedValue("not valid json at all");

      const content = "AWS: AKIAIOSFODNN7EXAMPLE and password=secret123";
      const result = await redactor.check("read_email", content);

      expect(result.action).toBe("modify");
      expect(result.content).toContain("[REDACTED:aws_key]");
    });

    it("should handle LLM returning empty findings array", async () => {
      llm.classify.mockResolvedValue(
        JSON.stringify({ findings: [] }),
      );

      const content = "Clean content with no secrets.";
      const result = await redactor.check("read_email", content);

      expect(result.action).toBe("allow");
    });

    it("should combine regex and LLM findings", async () => {
      llm.classify.mockResolvedValue(
        JSON.stringify({
          findings: [{ secret: "mysecretpassword", type: "password" }],
        }),
      );

      const content =
        "SSN: 123-45-6789 and the password is mysecretpassword";
      const result = await redactor.check("read_email", content);

      expect(result.action).toBe("modify");
      expect(result.content).toContain("[REDACTED:ssn]");
      expect(result.content).toContain("[REDACTED:password]");
      expect(result.content).not.toContain("123-45-6789");
      expect(result.content).not.toContain("mysecretpassword");
    });
  });

  describe("prefilter option", () => {
    it("no prefilter (default): LLM sees full post-Phase-1 content (parity with prior behavior)", async () => {
      llm.classify.mockResolvedValue(JSON.stringify({ findings: [] }));
      const r = new SecretRedactor({ llm });
      const content = "subject: Hello\nbody: My password is hunter2";
      await r.check("read_email", content);

      expect(llm.classify).toHaveBeenCalledTimes(1);
      expect(llm.classify.mock.calls[0][0]).toBe(content);
    });

    it("prefilter is invoked with (toolName, post-Phase-1 content) and its return value is sent to the LLM", async () => {
      llm.classify.mockResolvedValue(JSON.stringify({ findings: [] }));
      const prefilter = vi.fn((_tool: string, _c: string) => "BODY ONLY");
      const r = new SecretRedactor({ llm, prefilter });
      const content = "envelope-stuff\nbody-content";
      await r.check("get_event", content);

      expect(prefilter).toHaveBeenCalledWith("get_event", content);
      expect(llm.classify).toHaveBeenCalledTimes(1);
      expect(llm.classify.mock.calls[0][0]).toBe("BODY ONLY");
    });

    it("prefilter receives content with regex-redacted secrets already substituted", async () => {
      llm.classify.mockResolvedValue(JSON.stringify({ findings: [] }));
      const prefilter = vi.fn((_tool: string, c: string) => c);
      const r = new SecretRedactor({ llm, prefilter });
      const content = "ssh key in body: ghp_abcdefghijklmnopqrstuvwxyz1234567890ab";
      await r.check("get_event", content);

      const seen = prefilter.mock.calls[0][1];
      expect(seen).toContain("[REDACTED:github_token]");
      expect(seen).not.toContain("ghp_");
    });

    it("prefilter returning empty string skips the LLM call entirely", async () => {
      const prefilter = vi.fn(() => "");
      const r = new SecretRedactor({ llm, prefilter });
      const result = await r.check("get_event", "anything");

      expect(prefilter).toHaveBeenCalled();
      expect(llm.classify).not.toHaveBeenCalled();
      expect(result.action).toBe("allow");
    });

    it("prefilter empty string still allows Phase-1 regex findings to be reported", async () => {
      const prefilter = vi.fn(() => "");
      const r = new SecretRedactor({ llm, prefilter });
      const content = "body: ghp_abcdefghijklmnopqrstuvwxyz1234567890ab";
      const result = await r.check("get_event", content);

      expect(llm.classify).not.toHaveBeenCalled();
      expect(result.action).toBe("modify");
      expect(result.content).toContain("[REDACTED:github_token]");
    });

    it("LLM findings are applied to the FULL content, not just the prefilter slice", async () => {
      // The prefilter returns just the body, but the LLM-found secret string
      // appears in the full content too — replaceAll covers all occurrences.
      llm.classify.mockResolvedValue(
        JSON.stringify({ findings: [{ secret: "hunter2", type: "password" }] }),
      );
      const prefilter = (_tool: string, c: string) => {
        // pretend the body is everything after a literal marker
        const i = c.indexOf("BODY:");
        return i >= 0 ? c.slice(i) : c;
      };
      const r = new SecretRedactor({ llm, prefilter });
      const content = "ENVELOPE id=evt-123 hunter2-mention\nBODY: my password is hunter2";
      const result = await r.check("get_event", content);

      expect(result.action).toBe("modify");
      expect(result.content).not.toContain("hunter2");
      expect(result.content).toContain("[REDACTED:password]");
      // envelope was preserved (id stays put)
      expect(result.content).toContain("ENVELOPE id=evt-123");
    });

    it("LLM findings whose secret is not present in the full content are dropped (existing guard)", async () => {
      llm.classify.mockResolvedValue(
        JSON.stringify({
          findings: [
            { secret: "this-string-was-never-in-content", type: "password" },
          ],
        }),
      );
      const prefilter = (_tool: string, _c: string) => "irrelevant slice";
      const r = new SecretRedactor({ llm, prefilter });
      const content = "clean envelope, nothing leaked";
      const result = await r.check("get_event", content);

      expect(result.action).toBe("allow");
    });

    it("prefilter throwing an error falls back to scanning the full post-Phase-1 content", async () => {
      llm.classify.mockResolvedValue(JSON.stringify({ findings: [] }));
      const prefilter = vi.fn(() => {
        throw new Error("boom");
      });
      const r = new SecretRedactor({ llm, prefilter });
      const content = "some content";
      await r.check("get_event", content);

      expect(prefilter).toHaveBeenCalled();
      expect(llm.classify).toHaveBeenCalledTimes(1);
      expect(llm.classify.mock.calls[0][0]).toBe(content);
    });

    it("prefilter is called per check() invocation (no shared state)", async () => {
      llm.classify.mockResolvedValue(JSON.stringify({ findings: [] }));
      const prefilter = vi.fn((_tool: string, c: string) => c);
      const r = new SecretRedactor({ llm, prefilter });
      await r.check("get_event", "a");
      await r.check("get_event", "b");

      expect(prefilter).toHaveBeenCalledTimes(2);
      expect(prefilter.mock.calls[0][1]).toBe("a");
      expect(prefilter.mock.calls[1][1]).toBe("b");
    });
  });
});
