import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ContactsTrustResolver } from "../src/contacts/contacts-trust.js";

/**
 * Build a fake `contacts-cli` binary as a shell script that emits a
 * canned response. Returned path is absolute and executable.
 */
function makeFakeCli(tmp: string, body: string): string {
  const path = join(tmp, "contacts-cli");
  writeFileSync(path, body, { mode: 0o755 });
  chmodSync(path, 0o755);
  return path;
}

const LIST_DISPATCH_HEAD =
  '#!/bin/sh\nif [ "$1" = "auth-status" ]; then\n  echo \'{"authorization":"authorized","success":true}\'\n  exit 0\nfi\n';

function listScript(payload: string): string {
  return `${LIST_DISPATCH_HEAD}cat <<'EOF'\n${payload}\nEOF\n`;
}

describe("ContactsTrustResolver", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "contacts-trust-test-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns true for emails in the AddressBook (case-insensitive)", async () => {
    const cliPath = makeFakeCli(
      tmp,
      listScript(
        JSON.stringify({
          contacts: [
            { id: "1", fullName: "Alice", emails: ["alice@example.com"], phones: [] },
            { id: "2", fullName: "Bob", emails: ["BOB@Example.COM"], phones: [] },
          ],
          count: 2,
          success: true,
        }),
      ),
    );
    const resolver = new ContactsTrustResolver({ cliPath });

    expect(await resolver.isTrustedEmail("alice@example.com")).toBe(true);
    expect(await resolver.isTrustedEmail("ALICE@example.com")).toBe(true);
    expect(await resolver.isTrustedEmail("bob@example.com")).toBe(true);
    expect(await resolver.isTrustedEmail("  alice@example.com  ")).toBe(true);
  });

  it("returns false for emails not in the AddressBook", async () => {
    const cliPath = makeFakeCli(
      tmp,
      listScript(
        JSON.stringify({
          contacts: [
            { id: "1", fullName: "Alice", emails: ["alice@example.com"], phones: [] },
          ],
          count: 1,
          success: true,
        }),
      ),
    );
    const resolver = new ContactsTrustResolver({ cliPath });

    expect(await resolver.isTrustedEmail("eve@evil.com")).toBe(false);
  });

  it("returns false for empty / whitespace-only emails", async () => {
    const cliPath = makeFakeCli(
      tmp,
      listScript(JSON.stringify({ contacts: [], count: 0, success: true })),
    );
    const resolver = new ContactsTrustResolver({ cliPath });

    expect(await resolver.isTrustedEmail("")).toBe(false);
    expect(await resolver.isTrustedEmail("   ")).toBe(false);
  });

  it("ignores contacts with no emails array", async () => {
    const cliPath = makeFakeCli(
      tmp,
      listScript(
        JSON.stringify({
          contacts: [
            { id: "1", fullName: "Phoneless", phones: ["+15551234567"] },
            { id: "2", fullName: "Alice", emails: ["alice@example.com"] },
          ],
          count: 2,
          success: true,
        }),
      ),
    );
    const resolver = new ContactsTrustResolver({ cliPath });

    expect(await resolver.isTrustedEmail("alice@example.com")).toBe(true);
  });

  it("fail-closes when contacts-cli is missing", async () => {
    const resolver = new ContactsTrustResolver({
      cliPath: join(tmp, "does-not-exist"),
    });

    expect(await resolver.isTrustedEmail("alice@example.com")).toBe(false);
  });

  it("fail-closes when contacts-cli exits non-zero", async () => {
    const cliPath = makeFakeCli(
      tmp,
      "#!/bin/sh\necho 'kaboom' >&2\nexit 17\n",
    );
    const resolver = new ContactsTrustResolver({ cliPath });

    expect(await resolver.isTrustedEmail("alice@example.com")).toBe(false);
  });

  it("fail-closes on non-JSON output", async () => {
    const cliPath = makeFakeCli(
      tmp,
      "#!/bin/sh\necho 'not-json'\n",
    );
    const resolver = new ContactsTrustResolver({ cliPath });

    expect(await resolver.isTrustedEmail("alice@example.com")).toBe(false);
  });

  it("fail-closes when contacts field is missing or not an array", async () => {
    const cliPath = makeFakeCli(
      tmp,
      listScript(JSON.stringify({ count: 0 })),
    );
    const resolver = new ContactsTrustResolver({ cliPath });

    expect(await resolver.isTrustedEmail("alice@example.com")).toBe(false);
  });

  it("logs a degraded warning only once across many failures", async () => {
    const messages: string[] = [];
    const resolver = new ContactsTrustResolver({
      cliPath: join(tmp, "missing"),
      logger: { warn: (m) => messages.push(m) },
    });

    await resolver.isTrustedEmail("a@x.com");
    await resolver.isTrustedEmail("b@x.com");
    await resolver.isTrustedEmail("c@x.com");

    expect(messages.length).toBe(1);
    expect(messages[0]).toContain("degraded");
  });

  describe("healthCheck", () => {
    it("resolves when auth status is authorized", async () => {
      const cliPath = makeFakeCli(
        tmp,
        '#!/bin/sh\nif [ "$1" = "auth-status" ]; then echo \'{"authorization":"authorized"}\'; exit 0; fi\n',
      );
      const resolver = new ContactsTrustResolver({ cliPath });
      await expect(resolver.healthCheck()).resolves.toBeUndefined();
    });

    it("throws when auth status is notDetermined", async () => {
      const cliPath = makeFakeCli(
        tmp,
        '#!/bin/sh\nif [ "$1" = "auth-status" ]; then echo \'{"authorization":"notDetermined"}\'; exit 0; fi\n',
      );
      const resolver = new ContactsTrustResolver({ cliPath });
      await expect(resolver.healthCheck()).rejects.toThrow(/notDetermined/);
    });

    it("throws when CLI is missing", async () => {
      const resolver = new ContactsTrustResolver({
        cliPath: join(tmp, "missing"),
      });
      await expect(resolver.healthCheck()).rejects.toThrow();
    });

    it("throws on non-JSON auth-status output", async () => {
      const cliPath = makeFakeCli(tmp, "#!/bin/sh\necho garbage\n");
      const resolver = new ContactsTrustResolver({ cliPath });
      await expect(resolver.healthCheck()).rejects.toThrow(/non-JSON/);
    });
  });
});
