import keytar from "keytar";

const COPILOT_TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const DEFAULT_BASE_URL = "https://api.individual.githubcopilot.com";
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
const REFRESH_RETRY_MS = 60 * 1000;
const REFRESH_MIN_DELAY_MS = 5 * 1000;

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
}

export class CopilotLLMClient {
  private model: string;
  private githubToken?: string;
  private keychainService: string;
  private keychainAccount: string;
  private tokenState: TokenState | null = null;
  private openai: import("openai").default | null = null;
  private refreshTimer?: ReturnType<typeof setTimeout>;

  constructor(options: CopilotLLMClientOptions = {}) {
    this.model = options.model ?? "claude-haiku-4.5";
    this.githubToken = options.githubToken;
    this.keychainService = options.keychainService ?? "mcp-hooks";
    this.keychainAccount = options.keychainAccount ?? "github-pat";
  }

  async classify(content: string, systemPrompt: string): Promise<string> {
    const client = await this.getClient();
    const response = await client.chat.completions.create({
      model: this.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content },
      ],
      temperature: 0,
    });
    return response.choices[0]?.message?.content ?? "";
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
      const pat = this.githubToken ?? await this.getPatFromKeychain();
      if (!pat) {
        throw new Error(
          "No GitHub PAT found. Set githubToken option or store in keychain " +
          `(service: ${this.keychainService}, account: ${this.keychainAccount})`,
        );
      }

      const res = await fetch(COPILOT_TOKEN_URL, {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${pat}`,
        },
      });

      if (!res.ok) {
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
        baseURL: `${baseUrl}/v1`,
        apiKey: json.token,
        defaultHeaders: COPILOT_HEADERS,
      });

      this.scheduleRefresh();
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
