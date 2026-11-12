/**
 * Shared SERV chat intake types for Find and Resale.
 * Code does not parse shopper messages into fields — SERV asks and decides.
 */

export type ServChatRole = "user" | "assistant" | "progress";

export type ServChatMessage = {
  role: ServChatRole;
  content: string;
  at?: string;
};

export type ServChatTurnStatus = "ask" | "progress" | "continue" | "done" | "error";

/** Flatten chat for the agent note / journal transcript. */
export function formatServChatTranscript(messages: readonly ServChatMessage[]): string {
  const lines: string[] = [];
  for (const row of messages) {
    const text = typeof row.content === "string" ? row.content.trim() : "";
    if (!text) continue;
    if (row.role === "progress") {
      lines.push(`[progress] ${text}`);
      continue;
    }
    const who = row.role === "user" ? "Shopper" : "SERV";
    lines.push(`${who}: ${text}`);
  }
  return lines.join("\n\n");
}

export function appendServChatMessage(
  messages: readonly ServChatMessage[],
  next: ServChatMessage,
): ServChatMessage[] {
  const content = typeof next.content === "string" ? next.content.trim() : "";
  if (!content) return [...messages];
  return [...messages, { ...next, content, at: next.at ?? new Date().toISOString() }];
}

/** Generic live-eval reply when SERV asks anything — not tuned. */
export const LIVE_EVAL_GENERIC_SHOPPER_REPLY =
  "No other preferences — go ahead with what you have. If you need a fact sheet: budget as stated, ZIP optional, nationwide is fine.";
