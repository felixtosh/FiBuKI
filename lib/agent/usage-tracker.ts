/**
 * Token usage of one chat request, counted when each model call ends.
 *
 * Not from the stream: LangGraph rebuilds streamed chunks from text alone for
 * Gemini, so they never carry usage, and chat cost was logged as nothing.
 */

import { BaseCallbackHandler } from "@langchain/core/callbacks/base";
import { AIMessage } from "@langchain/core/messages";
import type { ChatGeneration, LLMResult } from "@langchain/core/outputs";

export function createUsageTracker() {
  const totals = { input: 0, output: 0 };
  const handler = BaseCallbackHandler.fromMethods({
    handleLLMEnd(output: LLMResult) {
      for (const gen of output.generations.flat()) {
        const message = (gen as ChatGeneration).message;
        const usage = AIMessage.isInstance(message) ? message.usage_metadata : undefined;
        if (!usage) continue;
        const input = usage.input_tokens || 0;
        totals.input += input;
        // total minus input, so a thinking model's reasoning (billed as output,
        // missing from output_tokens on Gemini) is counted too.
        totals.output += Math.max(usage.output_tokens || 0, (usage.total_tokens || 0) - input);
        console.log("[Token Usage]", usage);
      }
    },
  });
  return { handler, totals };
}
