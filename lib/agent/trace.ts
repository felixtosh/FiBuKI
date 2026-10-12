/**
 * One chat turn as a trace: what the User asked, every tool call with its
 * result (refused, held for the User, or run), and BuKI's reply.
 *
 * Built from the graph's final messages, so guard refusals and held
 * confirmations are in it as well as what ran. The route stores it in
 * `chatTraces/{turnId}` with the rubric's verdicts (lib/agent/rubric.ts), and
 * the golden set (lib/agent/evals) scores the same shape. The collection is
 * not in the client data policy: only the server writes it, and admins read
 * it through the listChatTraces callable.
 */

import type { BaseMessage } from "@langchain/core/messages";

export interface TraceStep {
  tool: string;
  /** The arguments as JSON text, cut to a few kB. */
  args: string;
  /** The result as text, cut to a few kB. */
  result: string;
  /** The trajectory guard refused it (lib/agent/trajectory-guard.ts). */
  guard?: string;
  /** Held for the User's click: a confirmation or a choice card. */
  awaitingUser?: boolean;
  /** It ran and answered with an error. */
  failed?: boolean;
}

export interface TraceView {
  userMessage: string;
  steps: TraceStep[];
  finalText: string;
  hitStepLimit: boolean;
  /** Tool rounds the model ran without a word to the User first. */
  silentRounds?: number;
}

const MAX_FIELD = 2000;

function cut(text: string, max = MAX_FIELD): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function typeOf(m: BaseMessage): string {
  return (m as { _getType?: () => string })._getType?.() ?? "";
}

export function textOf(m: BaseMessage): string {
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((b) => (typeof b === "string" ? b : b && typeof b === "object" && "text" in b ? String(b.text ?? "") : ""))
      .join("");
  }
  return "";
}

/** The steps and the final reply of the messages one turn added. */
export function traceSteps(turn: BaseMessage[]): { steps: TraceStep[]; finalText: string; silentRounds: number } {
  const results = new Map<string, string>();
  for (const m of turn) {
    if (typeOf(m) === "tool") results.set((m as { tool_call_id?: string }).tool_call_id ?? "", textOf(m));
  }
  const steps: TraceStep[] = [];
  let finalText = "";
  let silentRounds = 0;
  for (const m of turn) {
    if (typeOf(m) !== "ai") continue;
    const text = textOf(m).trim();
    if (text) finalText = text;
    const calls = (m as { tool_calls?: unknown[] }).tool_calls ?? [];
    if (calls.length > 0 && !text) silentRounds++;
    for (const tc of (m as { tool_calls?: Array<{ id?: string; name: string; args: unknown }> }).tool_calls ?? []) {
      const result = results.get(tc.id ?? "") ?? "";
      const step: TraceStep = { tool: tc.name, args: cut(JSON.stringify(tc.args ?? {})), result: cut(result) };
      const guard = /"guard"\s*:\s*"([a-z_]+)"/.exec(result)?.[1];
      if (guard) step.guard = guard;
      else if (/"status"\s*:\s*"awaiting_(confirmation|choice)"/.test(result)) step.awaitingUser = true;
      else if (/^\s*\{\s*"error"\s*:/.test(result) || /"success"\s*:\s*false/.test(result)) step.failed = true;
      steps.push(step);
    }
  }
  return { steps, finalText: cut(finalText, 4000), silentRounds };
}
