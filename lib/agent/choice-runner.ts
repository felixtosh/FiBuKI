/**
 * Run the User's click on a choice card (lib/agent/choices.ts).
 *
 * The click names a token and an option; consumeChoice returns the option the
 * server stored with that token, once, for its User. An option with a write
 * runs it now, as the session's User, through the chat tool (and so through
 * the same callables and ownership checks as any other call). Either way the
 * model gets a note saying what happened, appended to the User's message, and
 * the turn continues from there.
 */

import { consumeChoice } from "./pending-choice";
import { actionNote, choiceNote, type ChoiceRequest } from "./choices";

interface InvokableTool {
  name: string;
  invoke: (args: unknown, config?: unknown) => Promise<unknown>;
}

export interface ChoiceOutcome {
  /** What the model reads, appended to the User's message. */
  note: string;
  /** The write that ran, for the trace. */
  ran?: { tool: string; args: Record<string, unknown>; result: unknown };
}

const NOT_OPEN =
  "[That choice is no longer open: it was already answered or has expired, so nothing ran. Say so in one " +
  "sentence and offer to look again.]";

export async function runChoice(input: {
  userId: string;
  authHeader: string;
  choice: ChoiceRequest;
  tools: InvokableTool[];
}): Promise<ChoiceOutcome> {
  const { userId, authHeader, choice, tools } = input;
  const consumed = await consumeChoice(choice.token, userId, choice.optionId);
  if (!consumed) return { note: NOT_OPEN };

  const { kind, option } = consumed;
  if (option?.action) {
    const { tool: name, args } = option.action;
    const tool = tools.find((t) => t.name === name);
    if (!tool) return { note: NOT_OPEN };
    let result: unknown;
    try {
      result = await tool.invoke(args, { configurable: { userId, authHeader } });
    } catch (err) {
      result = { error: err instanceof Error ? err.message : "Tool failed" };
    }
    return {
      note: actionNote(name, kind === "confirmation" ? "approve" : option.label, result),
      ran: { tool: name, args, result },
    };
  }
  return { note: choiceNote(kind, choice.optionId, option, choice.feedback) };
}
