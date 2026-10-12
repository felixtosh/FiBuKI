/**
 * Bound the conversation the model reads each turn.
 *
 * The client sends the whole session every turn. A long session grows past a
 * small model's context and makes every turn slower and dearer on a large
 * one. The oldest turns go first, and the cut always lands on a User message,
 * so a tool call is never separated from its result (the model APIs refuse a
 * history that starts with a tool result or an unanswered call).
 */

import type { BaseMessage } from "@langchain/core/messages";

/** Roughly what a long session needs, and well inside a 32k-token open model. */
export const MAX_HISTORY_CHARS = 60_000;

function typeOf(m: BaseMessage): string {
  return (m as { _getType?: () => string })._getType?.() ?? "";
}

function sizeOf(m: BaseMessage): number {
  const c = m.content;
  const text = typeof c === "string" ? c : JSON.stringify(c ?? "");
  const calls = (m as { tool_calls?: unknown[] }).tool_calls;
  return text.length + (calls ? JSON.stringify(calls).length : 0);
}

/**
 * The newest messages that fit in `maxChars`, starting at a User message. The
 * last User message is always kept, with everything after it, even when that
 * alone is over the budget.
 */
export function trimHistory(messages: BaseMessage[], maxChars = MAX_HISTORY_CHARS): BaseMessage[] {
  if (messages.reduce((n, m) => n + sizeOf(m), 0) <= maxChars) return messages;
  // Walking back from the end, the suffix only grows: the earliest User
  // message whose suffix still fits is where the kept history starts.
  let suffix = 0;
  let start: number | undefined;
  let lastHuman: number | undefined;
  for (let i = messages.length - 1; i >= 0; i--) {
    suffix += sizeOf(messages[i]);
    if (typeOf(messages[i]) !== "human") continue;
    lastHuman ??= i;
    if (suffix <= maxChars) start = i;
    else break;
  }
  if (lastHuman === undefined) return messages;
  const from = start ?? lastHuman;
  return from === 0 ? messages : messages.slice(from);
}
