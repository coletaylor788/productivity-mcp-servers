import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TrustStore } from "../src/trust-store.js";

function makeStore(dir: string) {
  return new TrustStore({
    pluginId: "test-plugin",
    extractDestination: (_tool, params) =>
      (params.to as string) ?? null,
    storageDir: dir,
  });
}

describe("TrustStore", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "trust-store-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("resolve", () => {
    it("should return 'unknown' for unknown contacts", () => {
      const store = makeStore(tempDir);
      const level = store.resolve("send_email", { to: "stranger@example.com" });
      expect(level).toBe("unknown");
    });

    it("should return 'approved' after approve()", () => {
      const store = makeStore(tempDir);
      store.approve("alice@example.com");
      const level = store.resolve("send_email", { to: "alice@example.com" });
      expect(level).toBe("approved");
    });

    it("should return 'trusted' after trust()", () => {
      const store = makeStore(tempDir);
      store.trust("bob@example.com");
      const level = store.resolve("send_email", { to: "bob@example.com" });
      expect(level).toBe("trusted");
    });

    it("should return 'unknown' when extractDestination returns null", () => {
      const store = new TrustStore({
        pluginId: "test-plugin",
        extractDestination: () => null,
        storageDir: tempDir,
      });
      const level = store.resolve("send_email", {});
      expect(level).toBe("unknown");
    });
  });

  describe("domain matching", () => {
    it("should resolve via domain when contact is not directly known", () => {
      const store = makeStore(tempDir);
      store.seedDomains(["company.com"], "trusted");
      const level = store.resolve("send_email", {
        to: "anyone@company.com",
      });
      expect(level).toBe("trusted");
    });

    it("should prefer contact-level trust over domain-level trust", () => {
      const store = makeStore(tempDir);
      store.seedDomains(["company.com"], "trusted");
      store.approve("specific@company.com");

      // Contact-level "approved" should take precedence over domain "trusted"
      const level = store.resolve("send_email", {
        to: "specific@company.com",
      });
      expect(level).toBe("approved");
    });
  });

  describe("seedDomains", () => {
    it("should set trust level for multiple domains", () => {
      const store = makeStore(tempDir);
      store.seedDomains(["acme.com", "widgets.co"], "approved");

      expect(store.resolveDestination("user@acme.com")).toBe("approved");
      expect(store.resolveDestination("user@widgets.co")).toBe("approved");
    });

    it("should be case-insensitive", () => {
      const store = makeStore(tempDir);
      store.seedDomains(["ACME.COM"]);

      expect(store.resolveDestination("user@acme.com")).toBe("trusted");
    });
  });

  describe("resolveAll", () => {
    it("should return lowest trust among multiple destinations", () => {
      const store = makeStore(tempDir);
      store.trust("a@example.com");
      store.approve("b@example.com");

      // Mixed trusted + approved → approved (the lower one)
      expect(store.resolveAll(["a@example.com", "b@example.com"])).toBe(
        "approved",
      );
    });

    it("should return 'unknown' if any destination is unknown", () => {
      const store = makeStore(tempDir);
      store.trust("a@example.com");

      expect(
        store.resolveAll(["a@example.com", "stranger@example.com"]),
      ).toBe("unknown");
    });

    it("should return 'trusted' if all destinations are trusted", () => {
      const store = makeStore(tempDir);
      store.trust("a@example.com");
      store.trust("b@example.com");

      expect(store.resolveAll(["a@example.com", "b@example.com"])).toBe(
        "trusted",
      );
    });
  });

  describe("handleApprovalDecision", () => {
    it("allow-always on unknown → approved", () => {
      const store = makeStore(tempDir);
      store.handleApprovalDecision(["new@example.com"], "allow-always", false);
      expect(store.resolveDestination("new@example.com")).toBe("approved");
    });

    it("allow-always on approved + PII → trusted", () => {
      const store = makeStore(tempDir);
      store.approve("known@example.com");
      store.handleApprovalDecision(
        ["known@example.com"],
        "allow-always",
        true,
      );
      expect(store.resolveDestination("known@example.com")).toBe("trusted");
    });

    it("allow-always on approved without PII → stays approved", () => {
      const store = makeStore(tempDir);
      store.approve("known@example.com");
      store.handleApprovalDecision(
        ["known@example.com"],
        "allow-always",
        false,
      );
      expect(store.resolveDestination("known@example.com")).toBe("approved");
    });

    it("allow-once → no trust change", () => {
      const store = makeStore(tempDir);
      store.handleApprovalDecision(["new@example.com"], "allow-once", false);
      expect(store.resolveDestination("new@example.com")).toBe("unknown");
    });

    it("deny → no trust change", () => {
      const store = makeStore(tempDir);
      store.handleApprovalDecision(["new@example.com"], "deny", false);
      expect(store.resolveDestination("new@example.com")).toBe("unknown");
    });
  });

  describe("file persistence", () => {
    it("should save and reload trust data", () => {
      const store1 = makeStore(tempDir);
      store1.trust("saved@example.com");
      store1.seedDomains(["savedomain.com"], "approved");

      // Create a new store instance that reads from the same directory
      const store2 = makeStore(tempDir);
      expect(store2.resolveDestination("saved@example.com")).toBe("trusted");
      expect(store2.resolveDestination("user@savedomain.com")).toBe("approved");
    });
  });

  describe("file permissions", () => {
    it("should create file with 0o600 permissions", () => {
      const store = makeStore(tempDir);
      store.trust("perm@example.com");

      const filePath = join(tempDir, "test-plugin.json");
      const stats = statSync(filePath);
      const mode = stats.mode & 0o777;
      expect(mode).toBe(0o600);
    });
  });

  describe("case insensitivity", () => {
    it("should be case-insensitive for contacts", () => {
      const store = makeStore(tempDir);
      store.trust("Alice@Example.COM");
      expect(store.resolveDestination("alice@example.com")).toBe("trusted");
    });
  });
});
