/**
 * The chat's UI message history (AI SDK parts, as the client sends and stores
 * it) turned back into LangChain messages for the agent graph.
 */

import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from "@langchain/core/messages";

/** What the model reads for a tool call whose result never arrived. */
const NO_RESULT = "No result: this tool call was interrupted.";

export interface UIMessageInput {
  id: string;
  role: "user" | "assistant";
  content?: string;
  parts?: Array<{
    type: string;
    text?: string;
    toolCallId?: string;
    toolName?: string;
    args?: Record<string, unknown>;
    input?: Record<string, unknown>;
    result?: unknown;
    output?: unknown;
    errorText?: string;
    toolCall?: {
      id: string;
      name: string;
      args: Record<string, unknown>;
      result?: unknown;
    };
    [key: string]: unknown;
  }>;
  toolInvocations?: Array<{
    toolCallId: string;
    toolName: string;
    args?: Record<string, unknown>;
    result?: unknown;
    state?: string;
  }>;
}

/**
 * Convert UI messages to LangChain message format
 */
export function convertToLangChainMessages(uiMessages: UIMessageInput[]): BaseMessage[] {
  const result: BaseMessage[] = [];

  for (const msg of uiMessages) {
    if (msg.role === "user") {
      const content =
        msg.content ||
        msg.parts
          ?.filter((p) => p.type === "text" && p.text)
          .map((p) => p.text)
          .join("") ||
        "";
      if (content.trim()) {
        result.push(new HumanMessage(content));
      }
      continue;
    }

    if (msg.role === "assistant") {
      // Extract a tool call + result from a part, handling all storage formats
      const extractToolPart = (part: NonNullable<UIMessageInput["parts"]>[number]) => {
        let toolCallId: string | undefined;
        let toolName: string | undefined;
        let args: Record<string, unknown> = {};
        let toolResult: unknown;

        if (part.type === "dynamic-tool") {
          // The chat's tools stream as dynamic tools: the name is on the part,
          // not in its type. Dropping these lost every earlier tool result,
          // ids included, and the model invented ids on the next turn.
          toolName = part.toolName;
          toolCallId = part.toolCallId as string;
          args = (part.input || part.args || {}) as Record<string, unknown>;
          toolResult = part.output ?? part.result ?? part.errorText;
        } else if (part.type.startsWith("tool-")) {
          // Streaming format: part.type = "tool-<toolName>"
          toolName = part.type.replace("tool-", "");
          toolCallId = part.toolCallId as string;
          args = (part.args || part.input || {}) as Record<string, unknown>;
          toolResult = part.result ?? part.output ?? part.errorText;
        } else if (part.type === "tool" && part.toolCall) {
          // Worker transcript format: full toolCall object embedded in part
          const tc = part.toolCall;
          toolCallId = tc.id;
          toolName = tc.name;
          args = tc.args || {};
          toolResult = tc.result;
        } else if (part.type === "tool" && part.toolCallId && part.toolName) {
          // Stored format: toolCallId + toolName on part, args/result from toolInvocations
          const ti = msg.toolInvocations?.find(t => t.toolCallId === part.toolCallId);
          toolCallId = part.toolCallId;
          toolName = part.toolName;
          args = ti?.args || (part.args || part.input || {}) as Record<string, unknown>;
          toolResult = ti?.result ?? part.result ?? part.output;
        }

        if (toolCallId && toolName) {
          return { toolCallId, toolName, args, toolResult };
        }
        return null;
      };

      const isToolPart = (part: NonNullable<UIMessageInput["parts"]>[number]) =>
        part.type === "dynamic-tool" ||
        part.type.startsWith("tool-") ||
        (part.type === "tool" && (part.toolCall || (part.toolCallId && part.toolName)));

      if (msg.parts) {
        // Segment parts into multi-turn AIMessage → ToolMessage sequences.
        // This preserves the original sequential tool-calling structure that
        // was flattened when the streaming adapter merged multiple agent
        // loop iterations into a single assistant UI message.
        let pendingText = "";
        let pendingToolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
        let pendingToolResults: Array<{ toolCallId: string; result: unknown }> = [];

        const flushTurn = () => {
          if (pendingToolCalls.length > 0) {
            // Emit AIMessage with accumulated text + tool calls
            result.push(
              new AIMessage({
                content: pendingText,
                tool_calls: pendingToolCalls,
              })
            );
            // Emit ToolMessages for results
            for (const tr of pendingToolResults) {
              result.push(
                new ToolMessage({
                  tool_call_id: tr.toolCallId,
                  content: typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result),
                })
              );
            }
            pendingText = "";
            pendingToolCalls = [];
            pendingToolResults = [];
          }
          // Text-only content is NOT flushed here — it accumulates until
          // a tool part arrives or we reach the end of parts
        };

        for (const part of msg.parts) {
          if (part.type === "text" && part.text) {
            // If we already have tool calls queued, this text starts a new turn
            if (pendingToolCalls.length > 0) {
              flushTurn();
            }
            pendingText += part.text;
          } else if (isToolPart(part)) {
            const extracted = extractToolPart(part);
            if (extracted) {
              pendingToolCalls.push({
                id: extracted.toolCallId,
                name: extracted.toolName,
                args: extracted.args,
              });
              // Every tool call gets a result, or the model API refuses the
              // history; an interrupted call says so.
              pendingToolResults.push({
                toolCallId: extracted.toolCallId,
                result: extracted.toolResult ?? NO_RESULT,
              });
            }
          }
        }

        // Flush remaining tool calls
        if (pendingToolCalls.length > 0) {
          flushTurn();
        }

        // Emit any trailing text as a standalone AIMessage (no tool calls)
        if (pendingText) {
          result.push(new AIMessage({ content: pendingText }));
        }
      } else if (msg.content) {
        // No parts — legacy message format
        const textContent = msg.content;
        const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
        const toolResults: Array<{ toolCallId: string; result: unknown }> = [];

        if (msg.toolInvocations) {
          for (const ti of msg.toolInvocations) {
            toolCalls.push({ id: ti.toolCallId, name: ti.toolName, args: ti.args || {} });
            if (ti.result !== undefined) {
              toolResults.push({ toolCallId: ti.toolCallId, result: ti.result });
            }
          }
        }

        if (textContent || toolCalls.length > 0) {
          result.push(
            new AIMessage({
              content: textContent,
              tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
            })
          );
        }

        for (const tr of toolResults) {
          result.push(
            new ToolMessage({
              tool_call_id: tr.toolCallId,
              content: typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result),
            })
          );
        }
      } else {
        // Fallback: use toolInvocations if available, otherwise empty
        const toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }> = [];
        const toolResults: Array<{ toolCallId: string; result: unknown }> = [];

        if (msg.toolInvocations) {
          for (const ti of msg.toolInvocations) {
            toolCalls.push({ id: ti.toolCallId, name: ti.toolName, args: ti.args || {} });
            if (ti.result !== undefined) {
              toolResults.push({ toolCallId: ti.toolCallId, result: ti.result });
            }
          }
        }

        if (toolCalls.length > 0) {
          result.push(
            new AIMessage({
              content: "",
              tool_calls: toolCalls,
            })
          );
          for (const tr of toolResults) {
            result.push(
              new ToolMessage({
                tool_call_id: tr.toolCallId,
                content: typeof tr.result === "string" ? tr.result : JSON.stringify(tr.result),
              })
            );
          }
        }
      }
      continue;
    }

    // Any other role (including "system") is intentionally dropped — the agent
    // graph owns the system prompt; a client-sent system message must not be
    // able to replace it (CodeQL js/system-prompt-injection).
  }

  return result;
}
