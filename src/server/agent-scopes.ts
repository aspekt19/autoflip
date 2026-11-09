/**
 * Light scopes on af_ API keys for agent REST + MCP.
 * write-ish scopes imply read.
 */

export const AGENT_SCOPES = ["read", "check", "find"] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export const DEFAULT_AGENT_SCOPES: readonly AgentScope[] = ["read", "check", "find"];

export function normalizeAgentScopes(raw: unknown): AgentScope[] {
  if (!Array.isArray(raw)) return [...DEFAULT_AGENT_SCOPES];
  const set = new Set<AgentScope>();
  for (const item of raw) {
    if (item === "read" || item === "check" || item === "find") set.add(item);
  }
  if (set.has("check") || set.has("find")) set.add("read");
  if (set.size === 0) return [...DEFAULT_AGENT_SCOPES];
  return AGENT_SCOPES.filter((scope) => set.has(scope));
}

export function scopeAllows(scopes: readonly AgentScope[], needed: AgentScope): boolean {
  if (needed === "read") return scopes.includes("read") || scopes.includes("check") || scopes.includes("find");
  return scopes.includes(needed);
}

export function scopeDenial(needed: AgentScope, origin: string) {
  return {
    error_code: "missing_scope" as const,
    message: `This API key is missing the “${needed}” scope.`,
    credit_spent: false,
    retry_safe: false,
    next_steps: {
      action: "recreate_key_with_scope",
      summary: `Create a new key on ${origin}/developers with the ${needed} scope (or leave scopes blank for all).`,
      request: {
        method: "POST",
        url: `${origin}/api/agents/keys`,
        body: { label: "Agent key", scopes: ["read", "check", "find"] },
      },
      docs: `${origin}/developers`,
    },
  };
}
