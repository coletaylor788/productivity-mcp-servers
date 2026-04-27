export type HookAction = "allow" | "block" | "modify";

export interface HookFindings {
  /** Categorical labels of findings (e.g. ["api_key", "session_token"]). */
  findingTypes?: string[];
  /** Count of distinct findings. */
  findingCount?: number;
  /** Short, non-sensitive description of why the hook fired. */
  evidence?: string;
}

export interface HookResult {
  action: HookAction;
  content?: string;
  reason?: string;
  /** Optional metadata about why the hook returned this verdict. Safe for audit logs. */
  details?: HookFindings;
}

export interface ContentClassification {
  has_secrets: boolean;
  has_sensitive: boolean;
  has_personal: boolean;
}

export interface EgressHook {
  check(
    toolName: string,
    content: string,
    params?: Record<string, unknown>,
  ): Promise<HookResult>;
}

export interface IngressHook {
  /** Stable identifier for audit logs (e.g. "InjectionGuard"). */
  readonly name: string;
  check(toolName: string, content: string): Promise<HookResult>;
}
