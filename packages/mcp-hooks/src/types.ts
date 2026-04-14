export type HookAction = "allow" | "block" | "modify";

export interface HookResult {
  action: HookAction;
  content?: string;
  reason?: string;
}

export type TrustLevel = "unknown" | "approved" | "trusted";

export interface ContentClassification {
  has_secrets: boolean;
  has_sensitive: boolean;
  has_personal: boolean;
}

export interface SendApprovalResult extends HookResult {
  classification?: ContentClassification;
  trustLevel: TrustLevel;
  destination?: string;
  approval?: {
    title: string;
    description: string;
    severity: "info" | "warning" | "critical";
  };
}

export interface EgressHook {
  check(
    toolName: string,
    content: string,
    params?: Record<string, unknown>,
  ): Promise<HookResult | SendApprovalResult>;
}

export interface IngressHook {
  check(toolName: string, content: string): Promise<HookResult>;
}
