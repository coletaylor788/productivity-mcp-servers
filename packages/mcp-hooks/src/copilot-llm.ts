import keytar from "keytar";
import { log } from "./logger.js";

const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const DEFAULT_BASE_URL = "https://api.individual.githubcopilot.com";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const REFRESH_RETRY_MS = 60 * 1000;
const REFRESH_MIN_DELAY_MS = 5 * 1000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_SLOW_CALL_MS = 10_000;
const DEFAULT_TOKEN_EXCHANGE_TIMEOUT_MS = 15_000;

let llmCallSeq = 0;
function nextCallId(): string {
  llmCallSeq = (llmCallSeq + 1) % 1_000_000;
  return llmCallSeq.toString(36);
}

const COPILOT_HEADERS: Record<string, string> = {
  "User-Agent": "GitHubCopilotChat/0.35.0",
  "Editor-Version": "vscode/1.107.0",
  "Editor-Plugin-Version": "copilot-chat/0.35.0",
  "Copilot-Integration-Id": "vscode-chat",
};

interface TokenState {
  token: string;
  expiresAt: number;
  baseUrl: string;
  refreshInFlight?: Promise<void>;
}

interface CopilotLLMClientOptions {
  model?: string;
  githubToken?: string;
  keychainService?: string;
  keychainAccount?: string;
  /** Hard ceiling for a single chat completion request. Default 30s. */
  requestTimeoutMs?: number;
  /** Emit `llm_call_slow` warning if a call exceeds this. Default 10s. */
  slowCallMs?: number;
  /** Hard ceiling for the GitHub Copilot token-exchange request. Default 15s. */
  tokenExchangeTimeoutMs?: number;
}

export class CopilotLLMClient {
  private model: string;
  private githubToken?: string;
  private keychainService: string;
  private keychainAccount: string;
  private requestTimeoutMs: number;
  private slowCallMs: number;
  private tokenExchangeTimeoutMs: number;
  private tokenState: TokenState | null = null;
  private openai: import("openai").default | null = null;
  private refreshTimer?: ReturnType<typeof setTimeout>;

  constructor(options: CopilotLLMClientOptions = {}) {
    this.model = options.model ?? "claude-haiku-4.5";
    this.githubToken = options.githubToken;
    this.keychainService = options.keychainService ?? "openclaw";
    this.keychainAccount = options.keychainAccount ?? "github-pat";
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.slowCallMs = options.slowCallMs ?? DEFAULT_SLOW_CALL_MS;
    this.tokenExchangeTimeoutMs = options.tokenExchangeTimeoutMs ?? DEFAULT_TOKEN_EXCHANGE_TIMEOUT_MS;
  }

  async classify(
    content: string,
    systemPrompt: string,
    options: { temperature?: number; maxTokens?: number; label?: string } = {},
  ): Promise<string> {
    const client = await this.getClient();
    const callId = nextCallId();
    const label = options.label ?? "unlabeled";
    const start = Date.now();
    const abort = new AbortController();
    const hardTimeout = setTimeout(() => abort.abort(), this.requestTimeoutMs);
    const slowTimer = setTimeout(() => {
      log("llm_call_slow", {
        call_id: callId,
        label,
        model: this.model,
        elapsed_ms: Date.now() - start,
        threshold_ms: this.slowCallMs,
        content_len: content.length,
      });
    }, this.slowCallMs);

    log("llm_call_start", {
      call_id: callId,
      label,
      model: this.model,
      content_len: content.length,
      timeout_ms: this.requestTimeoutMs,
    });

    try {
      const response = await client.chat.completions.create(
        {
          model: this.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content },
          ],
          temperature: options.temperature ?? 0,
          ...(options.maxTokens != null ? { max_tokens: options.maxTokens } : {}),
        },
        {
          signal: abort.signal,
          timeout: this.requestTimeoutMs,
          maxRetries: 0,
        },
      );
      const raw = response.choices[0]?.message?.content ?? "";
      log("llm_call_done", {
        call_id: callId,
        label,
        model: this.model,
        elapsed_ms: Date.now() - start,
        outcome: "ok",
        response_len: raw.length,
      });
      return stripCodeFences(raw);
    } catch (err) {
      const elapsed = Date.now() - start;
      const isTimeout =
        abort.signal.aborted ||
        (err instanceof Error && /aborted|timeout/i.test(err.message));
      log(isTimeout ? "llm_call_timeout" : "llm_call_error", {
        call_id: callId,
        label,
        model: this.model,
        elapsed_ms: elapsed,
        outcome: isTimeout ? "timeout" : "error",
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    } finally {
      clearTimeout(hardTimeout);
      clearTimeout(slowTimer);
    }
  }

  private async getClient(): Promise<import("openai").default> {
    if (this.openai && this.tokenState && this.isTokenUsable(this.tokenState)) {
      return this.openai;
    }
    await this.refreshToken();
    return this.openai!;
  }

  private isTokenUsable(state: TokenState): boolean {
    return state.expiresAt - Date.now() > REFRESH_MARGIN_MS;
  }

  private async refreshToken(): Promise<void> {
    if (this.tokenState?.refreshInFlight) {
      await this.tokenState.refreshInFlight;
      return;
    }

    const doRefresh = async () => {
      const refreshStart = Date.now();
      log("token_refresh_start", { timeout_ms: this.tokenExchangeTimeoutMs });
      const pat = this.githubToken ?? await this.getPatFromKeychain();
      if (!pat) {
        log("token_refresh_error", {
          elapsed_ms: Date.now() - refreshStart,
          error: "no PAT found",
        });
        throw new Error(
          "No GitHub PAT found. Set githubToken option or store in keychain " +
          `(service: ${this.keychainService}, account: ${this.keychainAccount})`,
        );
      }

      let res: Response;
      try {
        res = await fetch(COPILOT_TOKEN_URL, {
          method: "GET",
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${pat}`,
          },
          signal: AbortSignal.timeout(this.tokenExchangeTimeoutMs),
        });
      } catch (err) {
        log("token_refresh_error", {
          elapsed_ms: Date.now() - refreshStart,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }

      if (!res.ok) {
        log("token_refresh_error", {
          elapsed_ms: Date.now() - refreshStart,
          status: res.status,
        });
        throw new Error(`Copilot token exchange failed: HTTP ${res.status}`);
      }

      const json = await res.json() as { token: string; expires_at: number };
      const expiresAt = this.parseExpiresAt(json.expires_at);
      const baseUrl = this.deriveBaseUrl(json.token) ?? DEFAULT_BASE_URL;

      this.tokenState = {
        token: json.token,
        expiresAt,
        baseUrl,
      };

      const { default: OpenAI } = await import("openai");
      this.openai = new OpenAI({
        baseURL: baseUrl,
        apiKey: json.token,
        defaultHeaders: COPILOT_HEADERS,
      });

      this.scheduleRefresh();
      log("token_refresh_done", {
        elapsed_ms: Date.now() - refreshStart,
        expires_in_ms: this.tokenState.expiresAt - Date.now(),
      });
    };

    const promise = doRefresh().finally(() => {
      if (this.tokenState) {
        this.tokenState.refreshInFlight = undefined;
      }
    });

    if (this.tokenState) {
      this.tokenState.refreshInFlight = promise;
    }
    await promise;
  }

  private parseExpiresAt(value: number): number {
    return value > 10_000_000_000 ? value : value * 1000;
  }

  private deriveBaseUrl(token: string): string | null {
    const match = token.match(/(?:^|;)\s*proxy-ep=([^;\s]+)/i);
    const proxyEp = match?.[1]?.trim();
    if (!proxyEp) return null;

    const host = proxyEp.replace(/^https?:\/\//, "").replace(/^proxy\./i, "api.");
    return host ? `https://${host}` : null;
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (!this.tokenState) return;

    const refreshAt = this.tokenState.expiresAt - REFRESH_MARGIN_MS;
    const delayMs = Math.max(REFRESH_MIN_DELAY_MS, refreshAt - Date.now());

    this.refreshTimer = setTimeout(() => {
      this.refreshToken().catch(() => {
        // Retry after REFRESH_RETRY_MS
        this.refreshTimer = setTimeout(() => {
          this.refreshToken().catch(() => undefined);
        }, REFRESH_RETRY_MS);
      });
    }, delayMs);
  }

  private async getPatFromKeychain(): Promise<string | null> {
    return keytar.getPassword(this.keychainService, this.keychainAccount);
  }

  destroy(): void {
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
  }
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const match = trimmed.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?\s*```$/);
  return match ? match[1]!.trim() : trimmed;
}
