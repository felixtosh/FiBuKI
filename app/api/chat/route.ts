export const dynamic = "force-dynamic";
/**
 * Chat API Route - Full LangGraph Implementation
 *
 * Uses LangGraph for agent orchestration with:
 * - @ai-sdk/langchain adapter for streaming
 * - LangFuse tracing
 * - Vercel AI SDK compatible response format
 */

import { getServerUserIdWithFallback } from "@/lib/auth/get-server-user";
import { SYSTEM_PROMPT } from "@/lib/chat/system-prompt";
import { getAdminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";

// Dynamic imports to avoid build-time analysis issues
const getAI = async () => import("ai");
const getLangchainAdapter = async () => import("@ai-sdk/langchain");
const getAgentGraph = async () => import("@/lib/agent/graph");
const getAgentModel = async () => import("@/lib/agent/model");
const getLangfuse = async () => import("@/lib/agent/langfuse");
const getLangChainMessages = async () => import("@langchain/core/messages");

const db = getAdminDb();

export const maxDuration = 60;

// ============================================================================
// Message Conversion
// ============================================================================

interface UIMessageInput {
  id: string;
  role: "user" | "assistant" | "system";
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
async function convertToLangChainMessages(uiMessages: UIMessageInput[]) {
  const { HumanMessage, AIMessage, SystemMessage, ToolMessage } = await getLangChainMessages();
  const result: InstanceType<typeof HumanMessage | typeof AIMessage | typeof SystemMessage | typeof ToolMessage>[] = [];

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

        if (part.type.startsWith("tool-")) {
          // Streaming format: part.type = "tool-<toolName>"
          toolName = part.type.replace("tool-", "");
          toolCallId = part.toolCallId as string;
          args = (part.args || part.input || {}) as Record<string, unknown>;
          toolResult = part.result ?? part.output;
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
              if (extracted.toolResult !== undefined) {
                pendingToolResults.push({
                  toolCallId: extracted.toolCallId,
                  result: extracted.toolResult,
                });
              }
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

    if (msg.role === "system" && msg.content) {
      result.push(new SystemMessage(msg.content));
    }
  }

  return result;
}

// AI Usage Logging is now inline in POST handler to use dynamic imports

// ============================================================================
// API Handler
// ============================================================================

export async function POST(req: Request) {
  // Dynamic imports at runtime
  const { createUIMessageStreamResponse } = await getAI();
  const { toUIMessageStream } = await getLangchainAdapter();
  const { buildAgentGraph } = await getAgentGraph();
  const { getModelId, calculateCost } = await getAgentModel();
  const { createLangfuseHandler, flushLangfuse } = await getLangfuse();
  const { SystemMessage } = await getLangChainMessages();

  const authHeader = req.headers.get("Authorization") || "";
  const userId = await getServerUserIdWithFallback(req);
  const { messages: rawMessages, modelProvider: requestedProvider } = await req.json();

  // Determine model provider (default to gemini for cost savings, anthropic as backup)
  const modelProvider: "anthropic" | "gemini" = requestedProvider || "gemini";

  console.log(`[Chat API] Starting LangGraph agent with ${modelProvider}, ${rawMessages.length} messages`);

  // Convert messages to LangChain format
  const messages = await convertToLangChainMessages(rawMessages);

  // Add system message if not present
  const hasSystemMessage = messages.some((m) => m instanceof SystemMessage);
  if (!hasSystemMessage) {
    messages.unshift(new SystemMessage(SYSTEM_PROMPT));
  }

  // Create Langfuse handler for tracing
  const langfuseHandler = createLangfuseHandler({
    userId,
    metadata: {
      messageCount: messages.length,
    },
  });

  // Build the graph
  const graph = buildAgentGraph();

  // Track token usage
  let totalInputTokens = 0;
  let totalOutputTokens = 0;

  // Use graph.stream with messages streamMode for best compatibility with toUIMessageStream
  const graphStream = await graph.stream(
    {
      messages,
      userId,
      authHeader,
      modelProvider,
      pendingConfirmation: null,
      shouldContinue: true,
    },
    {
      streamMode: ["messages"] as const,
      callbacks: langfuseHandler ? [langfuseHandler] : undefined,
    }
  );

  // Wrap stream to capture token usage while preserving the langgraph format
  // The graphStream with streamMode: ["messages"] yields tuples: ["messages", [messageChunk, metadata]]
  // We must yield the FULL tuple for toUIMessageStream to detect it as langgraph format
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function* trackUsage(): AsyncGenerator<any> {
    for await (const chunk of graphStream) {
      // Format: ["messages", [messageChunk, metadata]]
      if (!Array.isArray(chunk) || chunk[0] !== "messages") {
        // Pass through non-messages chunks
        yield chunk;
        continue;
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const msgData = chunk[1] as [any, unknown];
      if (!Array.isArray(msgData)) {
        yield chunk;
        continue;
      }

      const msgChunk = msgData[0];
      if (msgChunk) {
        // Extract usage metadata from kwargs (serialized LC format)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const chunkObj = msgChunk as any;
        const kwargs = chunkObj.kwargs || chunkObj;
        const usageMeta = kwargs.usage_metadata;

        if (usageMeta) {
          totalInputTokens += usageMeta.input_tokens || 0;
          totalOutputTokens += usageMeta.output_tokens || 0;
          console.log("[Token Usage]", usageMeta);
        }

        // Log content for debugging (from kwargs for serialized format)
        const content = kwargs.content;
        if (Array.isArray(content) && content.length > 0) {
          const textBlocks = content.filter((c: { type: string }) => c.type === "text");
          if (textBlocks.length > 0) {
            const text = textBlocks.map((c: { text: string }) => c.text || "").join("");
            if (text) {
              console.log("[Stream] Text:", JSON.stringify(text.slice(0, 50)));
            }
          }
          // Log tool calls
          const toolBlocks = content.filter((c: { type: string }) => c.type === "tool_use");
          if (toolBlocks.length > 0) {
            console.log("[Stream] Tool call:", JSON.stringify(toolBlocks[0]));
          }
        }

        // Log tool_call_chunks if present
        const toolCallChunks = kwargs.tool_call_chunks;
        if (toolCallChunks && toolCallChunks.length > 0) {
          console.log("[Stream] Tool chunks:", JSON.stringify(toolCallChunks));
        }
      }

      // Yield the FULL chunk (preserves langgraph format for toUIMessageStream)
      yield chunk;
    }
  }

  // Convert to UI message stream using official adapter
  // By yielding the full ["messages", [chunk, metadata]] format, the adapter
  // will detect this as langgraph format and properly handle serialized LC objects
  // Create a wrapper to log what chunks are being sent to the frontend
  const wrappedStream = new TransformStream({
    transform(chunk, controller) {
      // Log the chunk type
      if (chunk && typeof chunk === "object" && "type" in chunk) {
        const c = chunk as { type: string; [key: string]: unknown };
        if (c.type.includes("tool")) {
          console.log("[UI Chunk] Tool chunk:", JSON.stringify(c).slice(0, 200));
        }
      }
      controller.enqueue(chunk);
    },
  });

  const uiStream = toUIMessageStream(trackUsage(), {
    onText: (text) => {
      console.log("[UI Stream] onText:", JSON.stringify(text.slice(0, 50)));
    },
    onFinal: async () => {
      console.log("[Stream] Complete, tokens:", { totalInputTokens, totalOutputTokens });

      // Log AI usage inline
      if (userId && (totalInputTokens > 0 || totalOutputTokens > 0)) {
        const cost = calculateCost(modelProvider, totalInputTokens, totalOutputTokens);
        try {
          await db.collection("aiUsage").add({
            userId,
            function: "chat",
            model: getModelId(modelProvider),
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            estimatedCost: cost,
            createdAt: Timestamp.now(),
            metadata: null,
          });
          console.log(`[AI Usage] chat`, {
            model: getModelId(modelProvider),
            inputTokens: totalInputTokens,
            outputTokens: totalOutputTokens,
            estimatedCost: `$${cost.toFixed(4)}`,
          });
        } catch (error) {
          console.error("[AI Usage] Failed to log usage:", error);
        }
      }

      // Flush Langfuse
      await flushLangfuse();
    },
  });

  // Pipe through the logging wrapper
  const loggedStream = uiStream.pipeThrough(wrappedStream);
  return createUIMessageStreamResponse({ stream: loggedStream });
}
