/**
 * LangGraph Agent Graph
 *
 * Defines the agent graph with nodes for:
 * - Agent: LLM reasoning and tool selection
 * - Tools: Execute selected tools
 * - Confirmation: Handle tools requiring user confirmation
 * - Respond: Generate final response
 */

import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import {
  AIMessage,
  BaseMessage,
  HumanMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { ALL_TOOLS, TOOLS_REQUIRING_CONFIRMATION } from "./tools";
import { SYSTEM_PROMPT } from "@/lib/chat/system-prompt";
import { createChatModel, ModelProvider } from "./model";

// ============================================================================
// State Definition
// ============================================================================

/**
 * Agent state annotation
 */
const AgentStateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (prev, next) => [...prev, ...next],
    default: () => [],
  }),
  userId: Annotation<string>({
    reducer: (_, next) => next,
    default: () => "",
  }),
  authHeader: Annotation<string>({
    reducer: (_, next) => next,
    default: () => "",
  }),
  modelProvider: Annotation<ModelProvider>({
    reducer: (_, next) => next,
    default: () => "anthropic" as ModelProvider,
  }),
  pendingConfirmation: Annotation<{
    toolName: string;
    toolCallId: string;
    args: Record<string, unknown>;
  } | null>({
    reducer: (_, next) => next,
    default: () => null,
  }),
  shouldContinue: Annotation<boolean>({
    reducer: (_, next) => next,
    default: () => true,
  }),
});

type AgentState = typeof AgentStateAnnotation.State;

// ============================================================================
// Model Setup
// ============================================================================

console.log("[Graph] Available tools:", ALL_TOOLS.map(t => t.name).join(", "));

// Model cache to avoid recreating for same provider
const modelCache = new Map<ModelProvider, Awaited<ReturnType<typeof createChatModel>>>();

async function getModel(provider: ModelProvider) {
  if (!modelCache.has(provider)) {
    console.log(`[Graph] Creating ${provider} model`);
    const model = await createChatModel({ provider }, ALL_TOOLS);
    modelCache.set(provider, model);
  }
  return modelCache.get(provider)!;
}

// ============================================================================
// Graph Nodes
// ============================================================================

/**
 * Agent node - calls the LLM with tools
 */
async function agentNode(state: AgentState): Promise<Partial<AgentState>> {
  const { messages, userId, authHeader, modelProvider } = state;

  // Get the model for this provider
  const model = await getModel(modelProvider);

  // Add system message if not present
  const hasSystemMessage = messages.some((m) => m instanceof SystemMessage);
  const messagesWithSystem = hasSystemMessage
    ? messages
    : [new SystemMessage(SYSTEM_PROMPT), ...messages];

  // Debug: log message types
  console.log(`[Agent] Using ${modelProvider} model`);
  console.log("[Agent] Message types:", messagesWithSystem.map(m => m._getType()).join(", "));
  console.log("[Agent] Last message content:", messagesWithSystem[messagesWithSystem.length - 1].content?.toString().slice(0, 100));

  // Call the model
  const response = await model.invoke(messagesWithSystem, {
    configurable: {
      userId,
      authHeader,
    },
  });

  // Debug: log response type
  console.log("[Agent] Response has tool_calls:", !!(response as AIMessage).tool_calls?.length);
  if ((response as AIMessage).tool_calls?.length) {
    console.log("[Agent] Tool calls:", (response as AIMessage).tool_calls?.map(tc => tc.name).join(", "));
  }

  return {
    messages: [response],
  };
}

/**
 * Check if the agent wants to use a tool that requires confirmation
 */
function shouldConfirm(state: AgentState): "tools" | "confirm" | "respond" {
  const { messages } = state;
  const lastMessage = messages[messages.length - 1];

  // Check for tool calls - handle both AIMessage instances and plain objects

  const msgAny = lastMessage as any;
  const toolCalls = msgAny?.tool_calls || msgAny?.additional_kwargs?.tool_calls || [];

  console.log("[Router] Last message type:", lastMessage?._getType?.() || typeof lastMessage);
  console.log("[Router] Tool calls found:", toolCalls.length);

  // If no tool calls, go to respond
  if (!toolCalls.length) {
    return "respond";
  }

  // Check if any tool requires confirmation
  for (const toolCall of toolCalls) {
    if (TOOLS_REQUIRING_CONFIRMATION.includes(toolCall.name)) {
      return "confirm";
    }
  }

  // No confirmation needed, execute tools
  return "tools";
}

/**
 * Confirmation node - pauses for user confirmation
 */
async function confirmationNode(state: AgentState): Promise<Partial<AgentState>> {
  const { messages } = state;
  const lastMessage = messages[messages.length - 1];

  if (!(lastMessage instanceof AIMessage) || !lastMessage.tool_calls?.length) {
    return { shouldContinue: false };
  }

  // Find the tool call that requires confirmation
  const toolCall = lastMessage.tool_calls.find((tc) =>
    TOOLS_REQUIRING_CONFIRMATION.includes(tc.name)
  );

  if (!toolCall) {
    return { shouldContinue: true };
  }

  // Store pending confirmation
  return {
    pendingConfirmation: {
      toolName: toolCall.name,
      toolCallId: toolCall.id || "",
      args: toolCall.args as Record<string, unknown>,
    },
    shouldContinue: false, // Pause for user confirmation
  };
}

/**
 * Tools node - executes tools with userId/authHeader from state
 */
const rawToolsNode = new ToolNode(ALL_TOOLS);

// Wrap tools node to pass config with userId

async function toolsNode(state: AgentState, config?: any): Promise<Partial<AgentState>> {
  const { userId, authHeader } = state;
  console.log("[Tools] Executing tools node with userId:", userId ? "present" : "missing");

  // Merge the state's userId/authHeader into the config
  const toolConfig = {
    ...config,
    configurable: {
      ...config?.configurable,
      userId,
      authHeader,
    },
  };

  try {
    const result = await rawToolsNode.invoke(state, toolConfig);
    console.log("[Tools] Execution complete, got result with", result.messages?.length, "messages");
    return result;
  } catch (error) {
    console.error("[Tools] Error executing tools:", error);
    throw error;
  }
}

/**
 * Respond node - generates final response if no more tools
 */
async function respondNode(state: AgentState): Promise<Partial<AgentState>> {
  // The last AI message is the response
  return {
    shouldContinue: false,
  };
}

// ============================================================================
// Routing
// ============================================================================

/**
 * Route after agent node
 */
function routeAfterAgent(state: AgentState): "tools" | "confirm" | "respond" {
  const route = shouldConfirm(state);
  console.log("[Router] After agent, routing to:", route);
  return route;
}

/**
 * Route after tools node - check if we should continue
 */
function routeAfterTools(state: AgentState): "agent" | "respond" {
  const { messages } = state;
  const lastMessage = messages[messages.length - 1];

  // If the last message is a tool message, continue to agent
  // Use both instanceof and structural check for robustness with deserialized messages
  const msgType = lastMessage?._getType?.();
  if (lastMessage instanceof ToolMessage || msgType === "tool") {
    console.log("[Router] After tools, routing back to agent");
    return "agent";
  }

  console.log("[Router] After tools, routing to respond");
  return "respond";
}

// ============================================================================
// Graph Definition
// ============================================================================

/**
 * Build the agent graph
 */
export function buildAgentGraph() {
  console.log("[Graph] Building agent graph with tools:", ALL_TOOLS.map(t => t.name).join(", "));

  const graph = new StateGraph(AgentStateAnnotation)
    // Add nodes
    .addNode("agent", agentNode)
    .addNode("tools", toolsNode)
    .addNode("confirm", confirmationNode)
    .addNode("respond", respondNode)

    // Add edges
    .addEdge(START, "agent")
    .addConditionalEdges("agent", routeAfterAgent, {
      tools: "tools",
      confirm: "confirm",
      respond: "respond",
    })
    .addConditionalEdges("tools", routeAfterTools, {
      agent: "agent",
      respond: "respond",
    })
    .addEdge("confirm", END)
    .addEdge("respond", END);

  return graph.compile();
}

// ============================================================================
// Helper to run the graph
// ============================================================================

export interface RunGraphInput {
  messages: BaseMessage[];
  userId: string;
  authHeader: string;
  modelProvider?: ModelProvider;
}

// Re-export for consumers
export type { ModelProvider };

export interface RunGraphOutput {
  messages: BaseMessage[];
  pendingConfirmation: {
    toolName: string;
    toolCallId: string;
    args: Record<string, unknown>;
  } | null;
}

/**
 * Run the agent graph
 */
export async function runAgentGraph(input: RunGraphInput): Promise<RunGraphOutput> {
  const graph = buildAgentGraph();

  const result = await graph.invoke({
    messages: input.messages,
    userId: input.userId,
    authHeader: input.authHeader,
    modelProvider: input.modelProvider || "anthropic",
    pendingConfirmation: null,
    shouldContinue: true,
  });

  return {
    messages: result.messages,
    pendingConfirmation: result.pendingConfirmation,
  };
}

/**
 * Continue the graph after user confirmation
 */
export async function continueAfterConfirmation(
  input: RunGraphInput & {
    confirmed: boolean;
    pendingToolCall: {
      toolName: string;
      toolCallId: string;
      args: Record<string, unknown>;
    };
  }
): Promise<RunGraphOutput> {
  const graph = buildAgentGraph();

  // If confirmed, add a tool result message and continue
  // If not confirmed, add a message saying the action was cancelled
  let additionalMessages: BaseMessage[] = [];

  if (input.confirmed) {
    // Execute the tool
    const tool = ALL_TOOLS.find((t) => t.name === input.pendingToolCall.toolName);
    if (tool) {
      try {

        const result = await (tool as any).invoke(input.pendingToolCall.args, {
          configurable: {
            userId: input.userId,
            authHeader: input.authHeader,
          },
        });

        additionalMessages = [
          new ToolMessage({
            tool_call_id: input.pendingToolCall.toolCallId,
            content: typeof result === "string" ? result : JSON.stringify(result),
          }),
        ];
      } catch (error) {
        additionalMessages = [
          new ToolMessage({
            tool_call_id: input.pendingToolCall.toolCallId,
            content: JSON.stringify({
              error: error instanceof Error ? error.message : "Tool execution failed",
            }),
          }),
        ];
      }
    }
  } else {
    additionalMessages = [
      new ToolMessage({
        tool_call_id: input.pendingToolCall.toolCallId,
        content: JSON.stringify({
          cancelled: true,
          message: "User cancelled this action",
        }),
      }),
    ];
  }

  const result = await graph.invoke({
    messages: [...input.messages, ...additionalMessages],
    userId: input.userId,
    authHeader: input.authHeader,
    pendingConfirmation: null,
    shouldContinue: true,
  });

  return {
    messages: result.messages,
    pendingConfirmation: result.pendingConfirmation,
  };
}
