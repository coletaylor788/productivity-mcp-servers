import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import type { TrustLevel } from "./types.js";

interface TrustStoreData {
  contacts: Record<string, TrustLevel>;
  domains: Record<string, TrustLevel>;
}

interface TrustStoreOptions {
  pluginId: string;
  extractDestination: (toolName: string, params: Record<string, unknown>) => string | null;
  extractDomain?: (destination: string) => string | null;
  storageDir?: string;
}

export class TrustStore {
  private pluginId: string;
  private extractDestination: TrustStoreOptions["extractDestination"];
  private extractDomain: (destination: string) => string | null;
  private filePath: string;
  private data: TrustStoreData;

  constructor(options: TrustStoreOptions) {
    this.pluginId = options.pluginId;
    this.extractDestination = options.extractDestination;
    this.extractDomain = options.extractDomain ?? defaultExtractDomain;
    const dir = options.storageDir ?? join(homedir(), ".openclaw", "trust");
    this.filePath = join(dir, `${this.pluginId}.json`);
    this.data = this.load();
  }

  resolve(toolName: string, params: Record<string, unknown>): TrustLevel {
    const destination = this.extractDestination(toolName, params);
    if (!destination) return "unknown";
    return this.resolveDestination(destination);
  }

  resolveDestination(destination: string): TrustLevel {
    const contactLevel = this.data.contacts[destination.toLowerCase()];
    if (contactLevel) return contactLevel;

    const domain = this.extractDomain(destination);
    if (domain) {
      const domainLevel = this.data.domains[domain.toLowerCase()];
      if (domainLevel) return domainLevel;
    }

    return "unknown";
  }

  resolveAll(destinations: string[]): TrustLevel {
    let lowest: TrustLevel = "trusted";
    for (const dest of destinations) {
      const level = this.resolveDestination(dest);
      if (level === "unknown") return "unknown";
      if (level === "approved" && lowest === "trusted") lowest = "approved";
    }
    return lowest;
  }

  approve(destination: string): void {
    const key = destination.toLowerCase();
    if (!this.data.contacts[key] || this.data.contacts[key] === "unknown") {
      this.data.contacts[key] = "approved";
      this.save();
    }
  }

  trust(destination: string): void {
    this.data.contacts[destination.toLowerCase()] = "trusted";
    this.save();
  }

  seedDomains(domains: string[], level: TrustLevel = "trusted"): void {
    for (const domain of domains) {
      this.data.domains[domain.toLowerCase()] = level;
    }
    if (domains.length > 0) this.save();
  }

  handleApprovalDecision(
    destinations: string[],
    decision: "allow-once" | "allow-always" | "deny",
    piiDetected: boolean,
  ): void {
    if (decision !== "allow-always") return;

    for (const dest of destinations) {
      const current = this.resolveDestination(dest);
      if (current === "unknown") {
        this.approve(dest);
      } else if (current === "approved" && piiDetected) {
        this.trust(dest);
      }
    }
  }

  private load(): TrustStoreData {
    if (!existsSync(this.filePath)) {
      return { contacts: {}, domains: {} };
    }
    try {
      const raw = readFileSync(this.filePath, "utf8");
      return JSON.parse(raw) as TrustStoreData;
    } catch {
      return { contacts: {}, domains: {} };
    }
  }

  private save(): void {
    const dir = dirname(this.filePath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(this.filePath, JSON.stringify(this.data, null, 2) + "\n", "utf8");
    chmodSync(this.filePath, 0o600);
  }
}

function defaultExtractDomain(destination: string): string | null {
  const parts = destination.split("@");
  return parts.length === 2 ? parts[1]!.toLowerCase() : null;
}
