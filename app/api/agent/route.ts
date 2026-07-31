export const dynamic = "force-dynamic";
/**
 * LangGraph Agent API Route
 *
 * This route handles chat interactions using the LangGraph-based agent.
 * It provides:
 * - Message handling with tool execution
 * - Confirmation flow for write operations
 * - Langfuse tracing for observability
 */

import { NextRequest, NextResponse } from "next/server";
import { getServerUserIdWithFallback, unauthorizedResponse } from "@/lib/auth/get-server-user";

// Dynamic imports to avoid build-time analysis issues with LangChain
const getLangChainMessages = async () => import("@langchain/core/messages");
const getAgentGraph = async () => import("@/lib/agent/graph");
const getLangfuse = async () => import("@/lib/agent/langfuse");

// ============================================================================
// Types
// ============================================================================

interface MessageInput {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
  tool_call_id?: string;
}

interface RequestBody {
  messages: MessageInput[];
  confirmation?: {
    confirmed: boolean;
    toolName: string;
    toolCallId: string;
    args: Record<string, unknown>;
  };
}

// ============================================================================
// Message Conversion
// ============================================================================

async function convertMessages(messages: MessageInput[]) {
  const { HumanMessage, AIMessage, ToolMessage } = await getLangChainMessages();

  // role:"system" is not accepted input, but bodies are unvalidated JSON — keep
  // the runtime drop so a client-sent system message can never replace the
  // graph's own SYSTEM_PROMPT (CodeQL js/system-prompt-injection).
  return messages.filter((msg) => (msg.role as string) !== "system").map((msg) => {
    switch (msg.role) {
      case "user":
        return new HumanMessage(msg.content);
      case "assistant":
        if (msg.tool_calls?.length) {
          return new AIMessage({
            content: msg.content,
            tool_calls: msg.tool_calls.map((tc) => ({
              id: tc.id,
              name: tc.function.name,
              args: JSON.parse(tc.function.arguments),
            })),
          });
        }
        return new AIMessage(msg.content);
      case "tool":
        return new ToolMessage({
          content: msg.content,
          tool_call_id: msg.tool_call_id || "",
        });
      default:
        return new HumanMessage(msg.content);
    }
  });
}

async function serializeMessages(messages: unknown[]) {
  const { HumanMessage, AIMessage, SystemMessage, ToolMessage } = await getLangChainMessages();

  // System messages never leave the server (and are dropped on ingest anyway)
  return messages.filter((msg) => !(msg instanceof SystemMessage)).map((msg) => {
    if (msg instanceof HumanMessage) {
      return { role: "user", content: msg.content };
    }
    if (msg instanceof AIMessage) {
      const toolCalls = msg.tool_calls?.map((tc) => ({
        id: tc.id,
        type: "function" as const,
        function: {
          name: tc.name,
          arguments: JSON.stringify(tc.args),
        },
      }));
      return {
        role: "assistant",
        content: msg.content,
        ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
      };
    }
    if (msg instanceof ToolMessage) {
      return {
        role: "tool",
        content: msg.content,
        tool_call_id: msg.tool_call_id,
      };
    }
    return { role: "user", content: String(msg) };
  });
}

// ============================================================================
// API Handler
// ============================================================================

export async function POST(request: NextRequest) {
  try {
    const userId = await getServerUserIdWithFallback(request);
    if (!userId) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    // Dynamic imports at runtime
    const { runAgentGraph, continueAfterConfirmation } = await getAgentGraph();
    const { createLangfuseHandler, flushLangfuse } = await getLangfuse();

    const authHeader = request.headers.get("Authorization") || "";
    const body: RequestBody = await request.json();

    // Convert messages
    const messages = await convertMessages(body.messages);

    // Create Langfuse handler for tracing
    const langfuseHandler = createLangfuseHandler({
      userId,
      metadata: {
        messageCount: messages.length,
        hasConfirmation: !!body.confirmation,
      },
    });

    let result;

    // Check if this is a confirmation response
    if (body.confirmation) {
      result = await continueAfterConfirmation({
        messages,
        userId,
        authHeader,
        confirmed: body.confirmation.confirmed,
        pendingToolCall: {
          toolName: body.confirmation.toolName,
          toolCallId: body.confirmation.toolCallId,
          args: body.confirmation.args,
        },
      });
    } else {
      // Regular message handling
      result = await runAgentGraph({
        messages,
        userId,
        authHeader,
      });
    }

    // Flush Langfuse events
    await flushLangfuse();

    // Serialize response
    return NextResponse.json({
      messages: await serializeMessages(result.messages),
      pendingConfirmation: result.pendingConfirmation,
    });
  } catch (error) {
    const unauthorized = unauthorizedResponse(error);
    if (unauthorized) return unauthorized;
    console.error("[Agent API] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal server error" },
      { status: 500 }
    );
  }
}
