import type { CopilotLLMClient } from "../copilot-llm.js";
import type { HookResult, ContentClassification } from "../types.js";

const SECRETS_PROMPT = `You are a security classifier. Determine if the following content contains any secrets or credentials.

Secrets include: API keys, passwords, tokens, private keys, connection strings, database credentials, OAuth secrets, SSH credentials, webhook secrets, encryption keys, PINs, SSNs, driver's license numbers, passport numbers, credit card numbers, bank account numbers, 2FA codes, password reset links, temporary passwords, recovery codes, access codes (building, gate, Wi-Fi, meeting).

Do NOT flag: placeholder/example keys, discussions about keys, revoked keys, test/sandbox credentials, random hex strings, commit SHAs, UUIDs, hash outputs, public keys, encrypted ciphertext, code implementing auth without real keys, regex patterns, truncated/masked keys, version numbers, content IDs, booking confirmations, or general reference numbers.

Respond with JSON only: {"detected": true/false, "evidence": "brief description of what was found"}`;

const SENSITIVE_PROMPT = `You are a security classifier. Determine if the following content contains specific personal financial or medical data attributable to an identifiable person.

Flag as sensitive: specific medical diagnoses tied to a person, lab test results, medications with dosages, treatment plans, therapy session content, disability specifics, genetic/hereditary test results, specific salary/income amounts, tax amounts, debt amounts, account balances, investment holdings, mortgage/rent specifics, insurance policy details, credit scores, bankruptcy details, legal case specifics, employment termination details, performance reviews, workers comp details, gambling losses, child support amounts, SSNs, medical record numbers, precise home geolocation, credit card/bank account numbers, active affair details, criminal records with specifics, restraining order details, specific substance use with consequences.

Do NOT flag: general health inquiries ("what are symptoms of diabetes?"), medication information, health statistics, wellness/fitness questions, financial planning questions, tax strategy questions, salary research, market/industry data, hypothetical scenarios, news, academic content, product reviews, career advice, general legal questions, policy discussions, anonymized case studies, aggregate statistics, relationship status, sexual orientation, religious/political views, family situations (vague), general life events, hotel room numbers, travel itineraries, workout tracking, recipes, shopping lists, calendar scheduling, reminders, pregnancy announcements, allergies, charitable donations.

Respond with JSON only: {"detected": true/false, "evidence": "brief description of what was found"}`;

const PII_PROMPT = `You are a security classifier. Determine if the following content contains personally identifiable information (PII).

PII includes: full names (first + last), personal email addresses, phone numbers, street addresses, SSNs/national IDs, dates of birth, driver's license numbers, passport numbers, credit card numbers, bank account numbers, usernames linked to real identity, home IP addresses, license plates, VINs, biometric references, medical record numbers, student IDs, employee IDs with company, name + contact combinations, quasi-identifiers (last 4 SSN + DOB + zip), personal social media profiles, personal URLs, family member PII, minors' information, geolocation coordinates (home), membership/loyalty numbers with name, emergency contacts, children's school info, spouse details, health app data with name.

Do NOT flag: business/organization names, public figures in news context, fictional names, generic role references ("the CEO", "my doctor"), public email addresses (support@, info@), reserved/example data (user@example.com, 555-0100), just a first name alone, just a city/state, server/public IPs, MAC addresses in tech context, code variable names, placeholder data ("John Doe", "000-00-0000"), dates that aren't DOB, business phone numbers (1-800), public records references, aggregate demographics, anonymized identifiers, historical figures, celebrity public contact info, auto-generated usernames, contact lookup requests, pet names alone, relative references ("call my mom").

Respond with JSON only: {"detected": true/false, "evidence": "brief description of what was found"}`;

export class LeakGuard {
  private llm: CopilotLLMClient;

  constructor(options: { llm: CopilotLLMClient }) {
    this.llm = options.llm;
  }

  async check(toolName: string, content: string): Promise<HookResult> {
    const [secrets, sensitive, pii] = await Promise.all([
      this.classify(content, SECRETS_PROMPT),
      this.classify(content, SENSITIVE_PROMPT),
      this.classify(content, PII_PROMPT),
    ]);

    if (secrets.detected) {
      return { action: "block", reason: `Secrets detected: ${secrets.evidence}` };
    }
    if (sensitive.detected) {
      return { action: "block", reason: `Sensitive data detected: ${sensitive.evidence}` };
    }
    if (pii.detected) {
      return { action: "block", reason: `PII detected: ${pii.evidence}` };
    }

    return { action: "allow" };
  }

  private async classify(
    content: string,
    prompt: string,
  ): Promise<{ detected: boolean; evidence: string }> {
    try {
      const raw = await this.llm.classify(content, prompt);
      const parsed = JSON.parse(raw);
      return {
        detected: Boolean(parsed.detected),
        evidence: String(parsed.evidence ?? ""),
      };
    } catch {
      // On LLM failure, fail open (allow) to avoid blocking legitimate work
      return { detected: false, evidence: "" };
    }
  }
}
