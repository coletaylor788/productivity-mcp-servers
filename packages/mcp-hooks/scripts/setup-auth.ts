#!/usr/bin/env npx tsx
/**
 * One-time setup: authenticate with GitHub for Copilot API access.
 * Uses the same OAuth Device Code Flow as OpenClaw.
 * 
 * Usage: npx tsx scripts/setup-auth.ts
 */
import keytar from "keytar";

const CLIENT_ID = "Iv1.b507a08c87ecfe98";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const KEYCHAIN_SERVICE = "openclaw";
const KEYCHAIN_ACCOUNT = "github-pat";

async function requestDeviceCode(): Promise<{
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}> {
  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      scope: "read:user",
    }),
  });
  if (!res.ok) throw new Error(`Device code request failed: HTTP ${res.status}`);
  return res.json() as any;
}

async function pollForToken(deviceCode: string, interval: number, expiresAt: number): Promise<string> {
  while (Date.now() < expiresAt) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const res = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        device_code: deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });
    const json = (await res.json()) as any;
    if (json.access_token) return json.access_token;
    if (json.error === "authorization_pending") continue;
    if (json.error === "slow_down") {
      interval = Math.max(interval, (json.interval ?? interval) + 1);
      continue;
    }
    throw new Error(`OAuth error: ${json.error} — ${json.error_description ?? ""}`);
  }
  throw new Error("Device code expired. Please try again.");
}

async function main() {
  console.log("🔑 mcp-hooks: GitHub Copilot Authentication Setup\n");

  const existing = await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  if (existing) {
    const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
      headers: { Authorization: `Bearer ${existing}`, Accept: "application/json" },
    });
    if (res.ok) {
      console.log("✅ Already authenticated. Token in keychain is valid.");
      return;
    }
    console.log("⚠️  Existing token is invalid. Re-authenticating...\n");
  }

  const device = await requestDeviceCode();
  console.log(`📋 Open this URL in your browser:\n`);
  console.log(`   ${device.verification_uri}\n`);
  console.log(`📝 Enter this code: ${device.user_code}\n`);
  console.log(`⏳ Waiting for authorization...`);

  const expiresAt = Date.now() + device.expires_in * 1000;
  const token = await pollForToken(device.device_code, device.interval, expiresAt);

  await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, token);
  console.log(`\n✅ Token stored in keychain (service: ${KEYCHAIN_SERVICE}, account: ${KEYCHAIN_ACCOUNT})`);

  const res = await fetch("https://api.github.com/copilot_internal/v2/token", {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  if (res.ok) {
    console.log("✅ Copilot API access confirmed.");
  } else {
    console.log(`⚠️  Copilot token exchange returned HTTP ${res.status}. Your subscription may not include API access.`);
  }
}

main().catch((err) => {
  console.error("❌ Setup failed:", err.message);
  process.exit(1);
});
