export const dynamic = "force-dynamic";
/**
 * Chat API Route - Full LangGraph Implementation
 *
 * Uses LangGraph for agent orchestration with:
 * - @ai-sdk/langchain adapter for streaming
 * - LangFuse tracing
 * - Vercel AI SDK compatible response format
 */

import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";
import { getAdminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";

// Dynamic imports to avoid build-time analysis issues
const getAI = async () => import("ai");
const getLangchainAdapter = async () => import("@ai-sdk/langchain");
const getAgentGraph = async () => import("@/lib/agent/graph");
const getAgentModel = async () => import("@/lib/agent/model");
const getLangfuse = async () => import("@/lib/agent/langfuse");
const getUiMessages = async () => import("@/lib/agent/ui-messages");
const getUsageTracker = async () => import("@/lib/agent/usage-tracker");

const db = getAdminDb();

export const maxDuration = 60;

// Strip CR/LF so request-derived values cannot forge log lines
function sanitizeForLog(value: unknown): string {
  const raw = value instanceof Error ? value.stack || value.message : String(value);
  return raw.replace(/\n|\r/g, "");
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

  const authHeader = req.headers.get("Authorization") || "";
  let userId: string;
  try {
    userId = await getServerUserIdWithFallback(req);
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    throw error;
  }
  const { messages: rawMessages, modelProvider: requestedProvider } = await req.json();

  // Determine model provider (default to anthropic for tool-call reliability; gemini opt-in)
  const modelProvider: "anthropic" | "gemini" = requestedProvider || "anthropic";

  console.log(`[Chat API] Starting LangGraph agent with ${sanitizeForLog(modelProvider)}, ${sanitizeForLog(rawMessages.length)} messages`);

  // Convert messages to LangChain format. The agent graph owns the system
  // prompt (agentNode strips foreign SystemMessages and prepends its own).
  const { convertToLangChainMessages } = await getUiMessages();
  const messages = convertToLangChainMessages(rawMessages);

  // Create Langfuse handler for tracing
  const langfuseHandler = createLangfuseHandler({
    userId,
    metadata: {
      messageCount: messages.length,
    },
  });

  // Build the graph
  const graph = buildAgentGraph();

  // Token usage, counted when each model call ends (see lib/agent/usage-tracker.ts).
  const { createUsageTracker } = await getUsageTracker();
  const usage = createUsageTracker();

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
      callbacks: langfuseHandler ? [usage.handler, langfuseHandler] : [usage.handler],
    }
  );

  // Wrap stream to capture token usage while preserving the langgraph format
  // The graphStream with streamMode: ["messages"] yields tuples: ["messages", [messageChunk, metadata]]
  // We must yield the FULL tuple for toUIMessageStream to detect it as langgraph format

  async function* trackUsage(): AsyncGenerator<any> {
    // The try/catch is the point of this wrapper as much as the usage tracking is.
    //
    // Anything thrown while iterating the graph — a model call that fails, a tool
    // that rejects, a recursion limit — happens AFTER the response headers are
    // already on the wire, so it cannot become an HTTP error. Without a handler the
    // generator simply stops: the client sees the assistant's opening sentence and
    // then silence, and the server logs NOTHING. That is precisely how a broken tool
    // loop presented ("Let me check your Amazon transactions..." then nothing), and
    // the absence of any log is what made it hard to place.
    //
    // Rethrowing preserves the existing behaviour for the caller; the log is what
    // turns a silent stall into something diagnosable.
    try {
      yield* streamChunks();
    } catch (error) {
      console.error(
        "[Chat API] Stream failed mid-response — the client will see a truncated " +
          "answer with no error:",
        error instanceof Error ? (error.stack ?? error.message) : String(error),
      );
      throw error;
    }
  }

  async function* streamChunks(): AsyncGenerator<any> {
    for await (const chunk of graphStream) {
      // Format: ["messages", [messageChunk, metadata]]
      if (!Array.isArray(chunk) || chunk[0] !== "messages") {
        // Pass through non-messages chunks
        yield chunk;
        continue;
      }


      const msgData = chunk[1] as [any, unknown];
      if (!Array.isArray(msgData)) {
        yield chunk;
        continue;
      }

      const msgChunk = msgData[0];
      if (msgChunk) {
        const chunkObj = msgChunk as any;
        const kwargs = chunkObj.kwargs || chunkObj;
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
      console.log("[Stream] Complete, tokens:", usage.totals);

      // Log AI usage inline
      if (userId && (usage.totals.input > 0 || usage.totals.output > 0)) {
        const cost = calculateCost(modelProvider, usage.totals.input, usage.totals.output);
        try {
          await db.collection("aiUsage").add({
            userId,
            function: "chat",
            model: getModelId(modelProvider),
            inputTokens: usage.totals.input,
            outputTokens: usage.totals.output,
            estimatedCost: cost,
            createdAt: Timestamp.now(),
            metadata: null,
          });
          console.log(`[AI Usage] chat`, {
            model: getModelId(modelProvider),
            inputTokens: usage.totals.input,
            outputTokens: usage.totals.output,
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
