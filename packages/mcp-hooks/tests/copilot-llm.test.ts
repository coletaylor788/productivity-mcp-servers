import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock keytar before importing the module under test
vi.mock("keytar", () => ({
  default: {
    getPassword: vi.fn(),
  },
}));

// Mock openai
vi.mock("openai", () => {
  const MockOpenAI = vi.fn();
  return { default: MockOpenAI };
});

import keytar from "keytar";
import { CopilotLLMClient } from "../src/copilot-llm.js";

const mockKeytar = vi.mocked(keytar);

function mockFetchResponse(body: object, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

describe("CopilotLLMClient", () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers({ shouldAdvanceTime: false });
    mockKeytar.getPassword.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("token exchange", () => {
    it("should exchange PAT for Copilot token via fetch", async () => {
      const nowSec = Math.floor(Date.now() / 1000) + 3600;
      globalThis.fetch = mockFetchResponse({
        token: "copilot-tok-123",
        expires_at: nowSec,
      });

      const client = new CopilotLLMClient({ githubToken: "ghp_testpat" });
      // Trigger token exchange by calling classify (which calls getClient → refreshToken)
      const { default: OpenAI } = await import("openai");
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: '{"result": true}' } }],
      });
      vi.mocked(OpenAI).mockImplementation(
        () =>
          ({
            chat: { completions: { create: mockCreate } },
          }) as any,
      );

      await client.classify("test", "system prompt");

      expect(globalThis.fetch).toHaveBeenCalledWith(
        "https://api.github.com/copilot_internal/v2/token",
        expect.objectContaining({
          method: "GET",
          headers: expect.objectContaining({
            Authorization: "Bearer ghp_testpat",
          }),
        }),
      );
      client.destroy();
    });
  });

  describe("token caching", () => {
    it("should reuse cached token on second call", async () => {
      const nowSec = Math.floor(Date.now() / 1000) + 3600;
      globalThis.fetch = mockFetchResponse({
        token: "copilot-tok-cached",
        expires_at: nowSec,
      });

      const { default: OpenAI } = await import("openai");
      const mockCreate = vi.fn().mockResolvedValue({
        choices: [{ message: { content: "{}" } }],
      });
      vi.mocked(OpenAI).mockImplementation(
        () =>
          ({
            chat: { completions: { create: mockCreate } },
          }) as any,
      );

      const client = new CopilotLLMClient({ githubToken: "ghp_testpat" });

      await client.classify("test1", "prompt1");
      await client.classify("test2", "prompt2");

      // fetch should only be called once (token cached)
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      // But classify (create) should be called twice
      expect(mockCreate).toHaveBeenCalledTimes(2);
      client.destroy();
    });
  });

  describe("expiry detection", () => {
    it("should treat values > 10B as milliseconds", async () => {
      const expiresAtMs = Date.now() + 3600_000; // already in ms
      expect(expiresAtMs).toBeGreaterThan(10_000_000_000);

      globalThis.fetch = mockFetchResponse({
        token: "copilot-tok-ms",
        expires_at: expiresAtMs,
      });

      const { default: OpenAI } = await import("openai");
      vi.mocked(OpenAI).mockImplementation(
        () =>
          ({
            chat: {
              completions: {
                create: vi.fn().mockResolvedValue({
                  choices: [{ message: { content: "{}" } }],
                }),
              },
            },
          }) as any,
      );

      const client = new CopilotLLMClient({ githubToken: "ghp_test" });
      await client.classify("test", "prompt");

      // Token should be usable (not expired)
      // A second call should NOT trigger a new fetch
      await client.classify("test2", "prompt2");
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      client.destroy();
    });

    it("should treat values <= 10B as seconds and convert to milliseconds", async () => {
      const expiresAtSec = Math.floor(Date.now() / 1000) + 3600;
      expect(expiresAtSec).toBeLessThanOrEqual(10_000_000_000);

      globalThis.fetch = mockFetchResponse({
        token: "copilot-tok-sec",
        expires_at: expiresAtSec,
      });

      const { default: OpenAI } = await import("openai");
      vi.mocked(OpenAI).mockImplementation(
        () =>
          ({
            chat: {
              completions: {
                create: vi.fn().mockResolvedValue({
                  choices: [{ message: { content: "{}" } }],
                }),
              },
            },
          }) as any,
      );

      const client = new CopilotLLMClient({ githubToken: "ghp_test" });
      await client.classify("test", "prompt");

      // Second call should still use cached token
      await client.classify("test2", "prompt2");
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
      client.destroy();
    });
  });

  describe("refresh when token expires", () => {
    it("should refresh token when it becomes expired", async () => {
      // First token expires very soon (within REFRESH_MARGIN_MS of 5 minutes)
      const nowMs = Date.now();
      const expiresAtSoonSec = Math.floor(nowMs / 1000) + 60; // 60s from now, within 5min margin

      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                token: "copilot-tok-first",
                expires_at: expiresAtSoonSec,
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              token: "copilot-tok-refreshed",
              expires_at: Math.floor(Date.now() / 1000) + 7200,
            }),
        });
      });

      const { default: OpenAI } = await import("openai");
      vi.mocked(OpenAI).mockImplementation(
        () =>
          ({
            chat: {
              completions: {
                create: vi.fn().mockResolvedValue({
                  choices: [{ message: { content: "{}" } }],
                }),
              },
            },
          }) as any,
      );

      const client = new CopilotLLMClient({ githubToken: "ghp_test" });

      // First call triggers initial token fetch
      await client.classify("test", "prompt");
      expect(callCount).toBe(1);

      // Token is within REFRESH_MARGIN_MS so isTokenUsable returns false
      // Second call should trigger a refresh
      await client.classify("test2", "prompt2");
      expect(callCount).toBe(2);
      client.destroy();
    });
  });

  describe("concurrent dedup", () => {
    it("should deduplicate concurrent refresh calls", async () => {
      const nowSec = Math.floor(Date.now() / 1000) + 30; // within refresh margin

      let resolveFirst: () => void;
      const fetchBarrier = new Promise<void>((r) => {
        resolveFirst = r;
      });

      let callCount = 0;
      globalThis.fetch = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // First call: will resolve normally, setting up token state
          return {
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                token: "copilot-tok-initial",
                expires_at: nowSec,
              }),
          };
        }
        // Second call: delay to test dedup
        await fetchBarrier;
        return {
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              token: "copilot-tok-refreshed",
              expires_at: Math.floor(Date.now() / 1000) + 7200,
            }),
        };
      });

      const { default: OpenAI } = await import("openai");
      vi.mocked(OpenAI).mockImplementation(
        () =>
          ({
            chat: {
              completions: {
                create: vi.fn().mockResolvedValue({
                  choices: [{ message: { content: "{}" } }],
                }),
              },
            },
          }) as any,
      );

      const client = new CopilotLLMClient({ githubToken: "ghp_test" });

      // First call to set up initial token state
      await client.classify("init", "prompt");

      // Token is within margin, so next calls will trigger refresh.
      // Launch two concurrent classify calls
      const p1 = client.classify("test1", "prompt1");
      const p2 = client.classify("test2", "prompt2");

      // Release the barrier
      resolveFirst!();

      await Promise.all([p1, p2]);

      // fetch should be called twice total (initial + one refresh), NOT three times
      expect(callCount).toBe(2);
      client.destroy();
    });
  });

  describe("proxy-ep parsing", () => {
    it("should extract proxy-ep, replace proxy→api, and prepend https", async () => {
      globalThis.fetch = mockFetchResponse({
        token: "tid=abc;proxy-ep=proxy.business.githubcopilot.com;exp=123",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });

      const { default: OpenAI } = await import("openai");
      vi.mocked(OpenAI).mockImplementation(
        (opts: any) =>
          ({
            chat: {
              completions: {
                create: vi.fn().mockResolvedValue({
                  choices: [{ message: { content: "{}" } }],
                }),
              },
            },
            _baseURL: opts.baseURL,
          }) as any,
      );

      const client = new CopilotLLMClient({ githubToken: "ghp_test" });
      await client.classify("test", "prompt");

      // Verify OpenAI was constructed with the derived base URL
      expect(vi.mocked((await import("openai")).default)).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: "https://api.business.githubcopilot.com",
        }),
      );
      client.destroy();
    });

    it("should use default base URL when proxy-ep is missing", async () => {
      globalThis.fetch = mockFetchResponse({
        token: "copilot-tok-no-proxy",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });

      const { default: OpenAI } = await import("openai");
      vi.mocked(OpenAI).mockImplementation(
        () =>
          ({
            chat: {
              completions: {
                create: vi.fn().mockResolvedValue({
                  choices: [{ message: { content: "{}" } }],
                }),
              },
            },
          }) as any,
      );

      const client = new CopilotLLMClient({ githubToken: "ghp_test" });
      await client.classify("test", "prompt");

      expect(vi.mocked((await import("openai")).default)).toHaveBeenCalledWith(
        expect.objectContaining({
          baseURL: "https://api.individual.githubcopilot.com",
        }),
      );
      client.destroy();
    });
  });

  describe("auth error", () => {
    it("should throw on HTTP error from token exchange", async () => {
      globalThis.fetch = mockFetchResponse({}, 401);

      const client = new CopilotLLMClient({ githubToken: "ghp_bad" });
      await expect(client.classify("test", "prompt")).rejects.toThrow(
        "Copilot token exchange failed: HTTP 401",
      );
      client.destroy();
    });
  });

  describe("no PAT found", () => {
    it("should throw descriptive error when no PAT is available", async () => {
      mockKeytar.getPassword.mockResolvedValue(null);

      const client = new CopilotLLMClient();
      await expect(client.classify("test", "prompt")).rejects.toThrow(
        /No GitHub PAT found/,
      );
      client.destroy();
    });

    it("should include keychain details in error message", async () => {
      mockKeytar.getPassword.mockResolvedValue(null);

      const client = new CopilotLLMClient({
        keychainService: "my-service",
        keychainAccount: "my-account",
      });
      await expect(client.classify("test", "prompt")).rejects.toThrow(
        /service: my-service, account: my-account/,
      );
      client.destroy();
    });
  });

  describe("Copilot headers", () => {
    it("should pass Copilot headers to OpenAI client", async () => {
      globalThis.fetch = mockFetchResponse({
        token: "copilot-tok-headers",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });

      const { default: OpenAI } = await import("openai");
      vi.mocked(OpenAI).mockImplementation(
        () =>
          ({
            chat: {
              completions: {
                create: vi.fn().mockResolvedValue({
                  choices: [{ message: { content: "{}" } }],
                }),
              },
            },
          }) as any,
      );

      const client = new CopilotLLMClient({ githubToken: "ghp_test" });
      await client.classify("test", "prompt");

      expect(vi.mocked((await import("openai")).default)).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultHeaders: expect.objectContaining({
            "User-Agent": "GitHubCopilotChat/0.35.0",
            "Editor-Version": "vscode/1.107.0",
            "Editor-Plugin-Version": "copilot-chat/0.35.0",
            "Copilot-Integration-Id": "vscode-chat",
          }),
        }),
      );
      client.destroy();
    });
  });

  describe("keychain usage", () => {
    it("should read PAT from keychain when githubToken not provided", async () => {
      mockKeytar.getPassword.mockResolvedValue("ghp_from_keychain");
      globalThis.fetch = mockFetchResponse({
        token: "copilot-tok-kc",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      });

      const { default: OpenAI } = await import("openai");
      vi.mocked(OpenAI).mockImplementation(
        () =>
          ({
            chat: {
              completions: {
                create: vi.fn().mockResolvedValue({
                  choices: [{ message: { content: "{}" } }],
                }),
              },
            },
          }) as any,
      );

      const client = new CopilotLLMClient();
      await client.classify("test", "prompt");

      expect(mockKeytar.getPassword).toHaveBeenCalledWith(
        "openclaw",
        "github-pat",
      );
      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({
            Authorization: "Bearer ghp_from_keychain",
          }),
        }),
      );
      client.destroy();
    });
  });
});
