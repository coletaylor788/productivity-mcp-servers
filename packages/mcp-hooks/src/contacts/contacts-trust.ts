import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Resolves trust by membership in the local Contacts AddressBook (via apple-pim's
 * `contacts-cli`). No cache: every `isTrustedEmail` call shells out fresh.
 *
 * Egress is a low-frequency hot path (a handful of sends per day), so the
 * ~50–100ms per call is invisible — and eliminating the cache also eliminates
 * staleness, invalidation, and refresh-after-create bugs.
 *
 * Fail-closed: if `contacts-cli` is missing, returns non-zero, returns
 * unparseable output, or reports auth status other than `"authorized"`,
 * `isTrustedEmail` returns false. Callers should treat that as block.
 */
export class ContactsTrustResolver {
  private readonly cliPath: string;
  private readonly timeoutMs: number;
  private readonly logger?: ContactsLogger;
  private warnedDegraded = false;

  constructor(opts: ContactsTrustResolverOptions = {}) {
    this.cliPath = opts.cliPath ?? "contacts-cli";
    this.timeoutMs = opts.timeoutMs ?? 5000;
    this.logger = opts.logger;
  }

  /** True iff `email` (case-insensitively) appears in the local AddressBook. */
  async isTrustedEmail(email: string): Promise<boolean> {
    const normalized = normalizeEmail(email);
    if (!normalized) return false;

    const trusted = await this.fetchTrustedEmails();
    if (!trusted) return false;
    return trusted.has(normalized);
  }

  /**
   * Probe `contacts-cli auth-status`. Throws if the CLI is missing, fails, or
   * the AddressBook is not authorized for this process. Useful for plugin
   * register-time health checks; caller decides whether to surface the error.
   */
  async healthCheck(): Promise<void> {
    let raw: string;
    try {
      const { stdout } = await execFileAsync(
        this.cliPath,
        ["auth-status", "--format", "json"],
        { timeout: this.timeoutMs },
      );
      raw = stdout;
    } catch (err) {
      throw new Error(
        `contacts-cli auth-status failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`contacts-cli auth-status returned non-JSON: ${raw.slice(0, 200)}`);
    }

    const status =
      typeof parsed === "object" && parsed !== null
        ? String((parsed as { authorization?: unknown }).authorization ?? "")
        : "";
    if (status !== "authorized") {
      throw new Error(
        `contacts-cli auth status is "${status || "unknown"}"; expected "authorized"`,
      );
    }
  }

  /**
   * Read the AddressBook and return a Set of every trusted email, lowercased.
   * Returns null on any failure (fail-closed). Logs a single degraded warning
   * across the process lifetime to avoid spamming.
   */
  private async fetchTrustedEmails(): Promise<Set<string> | null> {
    let stdout: string;
    try {
      const result = await execFileAsync(
        this.cliPath,
        ["list", "--format", "json", "--limit", "5000"],
        { timeout: this.timeoutMs, maxBuffer: 10 * 1024 * 1024 },
      );
      stdout = result.stdout;
    } catch (err) {
      this.logDegradedOnce(
        `contacts-cli list failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      this.logDegradedOnce(
        `contacts-cli list returned non-JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return null;
    }

    const contacts =
      parsed && typeof parsed === "object"
        ? (parsed as { contacts?: unknown }).contacts
        : null;
    if (!Array.isArray(contacts)) {
      this.logDegradedOnce("contacts-cli list output missing `contacts` array");
      return null;
    }

    const trusted = new Set<string>();
    for (const c of contacts) {
      if (!c || typeof c !== "object") continue;
      const emails = (c as { emails?: unknown }).emails;
      if (!Array.isArray(emails)) continue;
      for (const e of emails) {
        const norm = typeof e === "string" ? normalizeEmail(e) : null;
        if (norm) trusted.add(norm);
      }
    }
    return trusted;
  }

  private logDegradedOnce(msg: string): void {
    if (this.warnedDegraded) return;
    this.warnedDegraded = true;
    this.logger?.warn?.(`[ContactsTrustResolver] degraded: ${msg}`);
  }
}

export interface ContactsTrustResolverOptions {
  /** Path/name of the contacts-cli binary. Default: "contacts-cli" (on PATH). */
  cliPath?: string;
  /** Per-invocation timeout for contacts-cli calls. Default: 5000 ms. */
  timeoutMs?: number;
  /** Optional logger sink. */
  logger?: ContactsLogger;
}

export interface ContactsLogger {
  warn?: (msg: string) => void;
  info?: (msg: string) => void;
}

function normalizeEmail(email: string): string | null {
  const trimmed = email.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}
