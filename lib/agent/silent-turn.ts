import { AIMessage, BaseMessage, ToolMessage } from "@langchain/core/messages";

/** Sent once when the model answers tool results with nothing (see agentNode). */
export const SILENT_TURN_NUDGE =
  "(Note from the app, not the user: you ran tools but wrote nothing. Reply to the user now, " +
  "in the language of their messages: one or two sentences on what you found or did, and what " +
  "comes next if anything. Do not call tools.)";

/** The model answered tool results with neither text nor further tool calls. */
export function endedSilentlyAfterTools(history: BaseMessage[], response: BaseMessage): boolean {
  const last = history[history.length - 1];
  const afterTools = last instanceof ToolMessage || last?._getType?.() === "tool";
  if (!afterTools) return false;
  if ((response as AIMessage).tool_calls?.length) return false;
  return response.text.trim() === "";
}
