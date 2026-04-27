export { type HookAction, type HookResult } from "./types.js";
export { type ContentClassification } from "./types.js";
export { type EgressHook, type IngressHook } from "./types.js";

export { CopilotLLMClient } from "./copilot-llm.js";

export { LeakGuard } from "./egress/leak-guard.js";
export {
  ContactsEgressGuard,
  type ContactsEgressGuardOptions,
  type ExtractDestinations,
} from "./egress/contacts-egress-guard.js";
export {
  ContactsTrustResolver,
  type ContactsTrustResolverOptions,
  type ContactsLogger,
} from "./contacts/contacts-trust.js";

export { InjectionGuard } from "./ingress/injection-guard.js";
export { SecretRedactor } from "./ingress/secret-redactor.js";
