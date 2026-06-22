/**
 * Worker Graph
 *
 * LangGraph implementation for worker agents.
 * Workers are independent graphs with restricted toolsets
 * that run automation tasks.
 */

import { StateGraph, Annotation, START, END } from "@langchain/langgraph";
import {
  AIMessage,
  BaseMessage,
  SystemMessage,
  ToolMessage,
} from "@langchain/core/messages";
import { ToolNode } from "@langchain/langgraph/prebuilt";
import { StructuredToolInterface } from "@langchain/core/tools";
import { ALL_TOOLS } from "./tools";
import { getWorkerConfig } from "./worker-configs";
import { getWorkerPrompt } from "@/lib/chat/worker-prompts";
import { createChatModel, ModelProvider } from "./model";
import { WorkerType, WorkerAction } from "@/types/worker";

// ============================================================================
// State Definition
// ============================================================================

/**
 * Worker state annotation
 */
const WorkerStateAnnotation = Annotation.Root({
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
  runId: Annotation<string>({
    reducer: (_, next) => next,
    default: () => "",
  }),
  workerType: Annotation<WorkerType>({
    reducer: (_, next) => next,
    default: () => "file_matching" as WorkerType,
  }),
  modelProvider: Annotation<ModelProvider>({
    reducer: (_, next) => next,
    default: () => "gemini" as ModelProvider,
  }),
  messageCount: Annotation<number>({
    reducer: (_, next) => next,
    default: () => 0,
  }),
  toolCallCount: Annotation<number>({
    reducer: (_, next) => next,
    default: () => 0,
  }),
  shouldContinue: Annotation<boolean>({
    reducer: (_, next) => next,
    default: () => true,
  }),
  actionsPerformed: Annotation<WorkerAction[]>({
    reducer: (prev, next) => [...(prev || []), ...(next || [])],
    default: () => [],
  }),
  receiptSearchProgress: Annotation<ReceiptSearchProgress>({
    reducer: (_, next) => next,
    default: () => createInitialReceiptSearchProgress(),
  }),
  receiptSearchEnforcementCount: Annotation<number>({
    reducer: (_, next) => next,
    default: () => 0,
  }),
});

type WorkerState = typeof WorkerStateAnnotation.State;

interface ReceiptSearchProgress {
  localSearchCalls: number;
  gmailAttachmentQueries: string[];
  gmailEmailQueries: string[];
  gmailUnavailable: boolean;
  sawEmailInvoiceSignal: boolean;
  analyzeEmailCalls: number;
  convertEmailCalls: number;
  recommendedConvertCount: number;
  pendingExtractionFileIds: string[];
  completedExtractionFileIds: string[];
  extractionWaitAttempts: Record<string, number>;
  connectSuccessCount: number;
  connectFailureCount: number;
}

interface ReceiptGateDecision {
  canFinalize: boolean;
  unmet: string[];
}

function createInitialReceiptSearchProgress(): ReceiptSearchProgress {
  return {
    localSearchCalls: 0,
    gmailAttachmentQueries: [],
    gmailEmailQueries: [],
    gmailUnavailable: false,
    sawEmailInvoiceSignal: false,
    analyzeEmailCalls: 0,
    convertEmailCalls: 0,
    recommendedConvertCount: 0,
    pendingExtractionFileIds: [],
    completedExtractionFileIds: [],
    extractionWaitAttempts: {},
    connectSuccessCount: 0,
    connectFailureCount: 0,
  };
}

function normalizeQuery(query: unknown): string | null {
  if (typeof query !== "string") {
    return null;
  }
  const trimmed = query.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function addUniqueString(target: string[], value: string | null) {
  if (!value) return;
  if (!target.includes(value)) {
    target.push(value);
  }
}

function addUniqueStrings(target: string[], values: unknown) {
  if (!Array.isArray(values)) return;
  for (const value of values) {
    addUniqueString(target, normalizeQuery(value));
  }
}

function addPendingExtractionFileId(progress: ReceiptSearchProgress, fileId: unknown) {
  if (typeof fileId !== "string" || fileId.length === 0) return;
  if (!progress.pendingExtractionFileIds.includes(fileId)) {
    progress.pendingExtractionFileIds.push(fileId);
  }
}

function markExtractionCompleted(progress: ReceiptSearchProgress, fileId: unknown) {
  if (typeof fileId !== "string" || fileId.length === 0) return;
  if (!progress.completedExtractionFileIds.includes(fileId)) {
    progress.completedExtractionFileIds.push(fileId);
  }
}

function parseToolArgs(args: unknown): Record<string, unknown> {
  if (typeof args === "string") {
    try {
      const parsed = JSON.parse(args);
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return args && typeof args === "object" ? args as Record<string, unknown> : {};
}

function parseToolResultContent(content: unknown): Record<string, unknown> {
  if (typeof content === "string") {
    try {
      const parsed = JSON.parse(content);
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part === "string") {
        try {
          const parsed = JSON.parse(part);
          if (parsed && typeof parsed === "object") {
            return parsed as Record<string, unknown>;
          }
        } catch {
          // Continue trying other parts
        }
      }
      if (part && typeof part === "object" && "text" in part) {
        const text = (part as { text?: unknown }).text;
        if (typeof text === "string") {
          try {
            const parsed = JSON.parse(text);
            if (parsed && typeof parsed === "object") {
              return parsed as Record<string, unknown>;
            }
          } catch {
            // Continue trying other parts
          }
        }
      }
    }
  }
  return content && typeof content === "object" ? content as Record<string, unknown> : {};
}

function getToolCalls(message: BaseMessage): Array<{ id?: string; name?: string; args?: unknown }> {

  const msgAny = message as any;
  return msgAny?.tool_calls || msgAny?.additional_kwargs?.tool_calls || [];
}

function evaluateReceiptGate(state: WorkerState): ReceiptGateDecision {
  if (state.workerType !== "receipt_search") {
    return { canFinalize: true, unmet: [] };
  }

  const progress = (state.receiptSearchProgress || createInitialReceiptSearchProgress()) as ReceiptSearchProgress;

  // Early-success bypass: once a connection succeeded, no need to keep searching.
  if (progress.connectSuccessCount > 0) {
    return { canFinalize: true, unmet: [] };
  }

  const unmet: string[] = [];

  const localOk = progress.localSearchCalls >= 1;
  if (!localOk) {
    unmet.push("Run searchLocalFiles at least once.");
  }

  if (!progress.gmailUnavailable) {
    if (progress.gmailAttachmentQueries.length < 2) {
      unmet.push("Try at least 2 Gmail attachment queries.");
    }
    if (progress.gmailEmailQueries.length < 2) {
      unmet.push("Try at least 2 Gmail email queries.");
    }
  }

  if (progress.sawEmailInvoiceSignal && progress.analyzeEmailCalls < 1) {
    unmet.push("Invoice-like emails were found; run analyzeEmail on top candidates.");
  }

  if (progress.recommendedConvertCount > 0 && progress.convertEmailCalls < 1) {
    unmet.push("analyzeEmail recommended conversion; run convertEmailToPdf on at least one candidate.");
  }

  const unresolvedExtractionIds = progress.pendingExtractionFileIds.filter((fileId) => {
    if (progress.completedExtractionFileIds.includes(fileId)) {
      return false;
    }
    const attempts = progress.extractionWaitAttempts[fileId] || 0;
    // Allow finalization after several timed-out waits to avoid hard deadlocks when extraction queue is delayed.
    return attempts < 3;
  });

  if (unresolvedExtractionIds.length > 0) {
    unmet.push(
      `Wait for extraction before deciding (${unresolvedExtractionIds.length} file(s) still pending).`
    );
  }

  return { canFinalize: unmet.length === 0, unmet };
}

// ============================================================================
// Tool Filtering
// ============================================================================

/**
 * Filter tools based on worker config
 */
function getWorkerTools(workerType: WorkerType): StructuredToolInterface[] {
  const config = getWorkerConfig(workerType);
  const allowedTools = new Set(config.toolNames);

  const filteredTools = ALL_TOOLS.filter((tool) => allowedTools.has(tool.name));

  console.log(
    `[WorkerGraph] Filtered to ${filteredTools.length} tools for ${workerType}:`,
    filteredTools.map((t) => t.name).join(", ")
  );

  return filteredTools;
}

// ============================================================================
// Model Cache
// ============================================================================

// Cache models per worker type + provider combination
const modelCache = new Map<string, Awaited<ReturnType<typeof createChatModel>>>();

async function getWorkerModel(workerType: WorkerType, provider: ModelProvider) {
  const cacheKey = `${workerType}:${provider}`;

  if (!modelCache.has(cacheKey)) {
    console.log(`[WorkerGraph] Creating ${provider} model for ${workerType}`);
    const tools = getWorkerTools(workerType);
    const model = await createChatModel({ provider }, tools);
    modelCache.set(cacheKey, model);
  }

  return modelCache.get(cacheKey)!;
}

// ============================================================================
// Graph Nodes
// ============================================================================

/**
 * Agent node - calls the LLM with tools
 */
async function agentNode(state: WorkerState): Promise<Partial<WorkerState>> {
  const { messages, workerType, modelProvider } = state;
  const config = getWorkerConfig(workerType);

  // Get the model
  const model = await getWorkerModel(workerType, modelProvider);

  // Add system message if not present
  const hasSystemMessage = messages.some((m) => m instanceof SystemMessage);
  const systemPrompt = getWorkerPrompt(config.systemPromptKey);
  const messagesWithSystem = hasSystemMessage
    ? messages
    : [new SystemMessage(systemPrompt), ...messages];

  console.log(`[Worker:${workerType}] Agent node, ${messagesWithSystem.length} messages`);

  // Call the model
  let response;
  try {
    response = await model.invoke(messagesWithSystem, {
      configurable: {
        userId: state.userId,
        authHeader: state.authHeader,
        workerType: state.workerType,
      },
    });
  } catch (error) {
    console.error(`[Worker:${workerType}] Model invoke failed:`, error);
    // Log the last few messages for debugging
    const lastMessages = messagesWithSystem.slice(-3);
    console.error(`[Worker:${workerType}] Last messages:`, JSON.stringify(lastMessages.map(m => ({
      type: m.constructor.name,
      content: typeof m.content === 'string' ? m.content.slice(0, 200) : m.content,
    })), null, 2));
    throw error;
  }

  // Count messages for runaway prevention
  const newMessageCount = state.messageCount + 1;

  return {
    messages: [response],
    messageCount: newMessageCount,
  };
}

/**
 * Create tools node for a specific worker type
 */
function createToolsNode(workerType: WorkerType) {
  const tools = getWorkerTools(workerType);
  const rawToolsNode = new ToolNode(tools);

  return async function toolsNode(
    state: WorkerState,

    config?: any
  ): Promise<Partial<WorkerState>> {
    const { userId, authHeader, toolCallCount, workerType } = state;

    const toolConfig = {
      ...config,
      configurable: {
        ...config?.configurable,
        userId,
        authHeader,
        workerType,
      },
    };

    try {
      const result = await rawToolsNode.invoke(state, toolConfig);
      // Count individual tool calls (each tool result is a message)
      const newToolCalls = result.messages?.length || 0;
      const newToolCallCount = toolCallCount + newToolCalls;
      console.log(`[Worker:${workerType}] Tools executed: ${newToolCalls} calls (total: ${newToolCallCount})`);

      let receiptSearchProgress = state.receiptSearchProgress || createInitialReceiptSearchProgress();
      if (workerType === "receipt_search") {
        receiptSearchProgress = {
          ...receiptSearchProgress,
          gmailAttachmentQueries: [...(receiptSearchProgress.gmailAttachmentQueries || [])],
          gmailEmailQueries: [...(receiptSearchProgress.gmailEmailQueries || [])],
          pendingExtractionFileIds: [...(receiptSearchProgress.pendingExtractionFileIds || [])],
          completedExtractionFileIds: [...(receiptSearchProgress.completedExtractionFileIds || [])],
          extractionWaitAttempts: { ...(receiptSearchProgress.extractionWaitAttempts || {}) },
        };

        const lastMessage = state.messages[state.messages.length - 1];
        const toolCalls = lastMessage ? getToolCalls(lastMessage) : [];
        const toolMessages = ((result.messages || []) as BaseMessage[])
          .filter((m): m is ToolMessage => m instanceof ToolMessage);
        const toolMessagesByCallId = new Map<string, ToolMessage>();
        for (const toolMessage of toolMessages) {
          const toolCallId = (toolMessage as unknown as { tool_call_id?: string }).tool_call_id;
          if (toolCallId) {
            toolMessagesByCallId.set(toolCallId, toolMessage);
          }
        }

        let sequentialIndex = 0;
        for (const toolCall of toolCalls) {
          const toolName = toolCall.name || "";
          const args = parseToolArgs(toolCall.args);
          const toolMessage = toolCall.id ? toolMessagesByCallId.get(toolCall.id) : toolMessages[sequentialIndex];
          const output = parseToolResultContent(toolMessage?.content);

          if (toolName === "searchLocalFiles") {
            receiptSearchProgress.localSearchCalls += 1;
          }

          if (toolName === "searchGmailAttachments") {
            addUniqueStrings(receiptSearchProgress.gmailAttachmentQueries, output.queriesUsed);
            addUniqueString(
              receiptSearchProgress.gmailAttachmentQueries,
              normalizeQuery(args.query)
            );
            const integrationCount = typeof output.integrationCount === "number"
              ? output.integrationCount
              : null;
            if (output.gmailNotConnected === true || integrationCount === 0) {
              receiptSearchProgress.gmailUnavailable = true;
            }
            const candidates = Array.isArray(output.candidates) ? output.candidates : [];
            if (
              candidates.some((candidate) => {
                const classification = (candidate as { classification?: unknown }).classification;
                if (!classification || typeof classification !== "object") return false;
                const c = classification as { possibleMailInvoice?: unknown; possibleInvoiceLink?: unknown };
                return c.possibleMailInvoice === true || c.possibleInvoiceLink === true;
              })
            ) {
              receiptSearchProgress.sawEmailInvoiceSignal = true;
            }
          }

          if (toolName === "searchGmailEmails") {
            addUniqueString(
              receiptSearchProgress.gmailEmailQueries,
              normalizeQuery(output.query ?? args.query)
            );
            const integrationCount = typeof output.integrationCount === "number"
              ? output.integrationCount
              : null;
            if (output.gmailNotConnected === true || integrationCount === 0) {
              receiptSearchProgress.gmailUnavailable = true;
            }
            const emails = Array.isArray(output.emails) ? output.emails : [];
            if (
              emails.some((email) => {
                const classification = (email as { classification?: unknown }).classification;
                if (!classification || typeof classification !== "object") return false;
                const c = classification as { possibleMailInvoice?: unknown; possibleInvoiceLink?: unknown };
                return c.possibleMailInvoice === true || c.possibleInvoiceLink === true;
              }) ||
              (Array.isArray(output.recommendedAnalyzeCandidates) && output.recommendedAnalyzeCandidates.length > 0)
            ) {
              receiptSearchProgress.sawEmailInvoiceSignal = true;
            }
          }

          if (toolName === "analyzeEmail") {
            receiptSearchProgress.analyzeEmailCalls += 1;
            if (output.hasInvoiceLink === true || output.isMailInvoice === true) {
              receiptSearchProgress.sawEmailInvoiceSignal = true;
            }
            if (output.shouldConvertToPdf === true || output.recommendedAction === "convertEmailToPdf") {
              receiptSearchProgress.recommendedConvertCount += 1;
            }
          }

          if (toolName === "downloadGmailAttachment") {
            if (Array.isArray(output.fileIdsNeedingExtraction)) {
              for (const fileId of output.fileIdsNeedingExtraction) {
                addPendingExtractionFileId(receiptSearchProgress, fileId);
              }
            }
            const fallbackResults = Array.isArray(output.results) ? output.results : [];
            for (const row of fallbackResults) {
              const typedRow = row as { success?: unknown; fileId?: unknown; alreadyExists?: unknown };
              if (typedRow.success === true && typedRow.alreadyExists !== true) {
                addPendingExtractionFileId(receiptSearchProgress, typedRow.fileId);
              }
            }
          }

          if (toolName === "convertEmailToPdf") {
            receiptSearchProgress.convertEmailCalls += 1;
            if (output.success === true) {
              addPendingExtractionFileId(receiptSearchProgress, output.fileId);
            }
          }

          if (toolName === "waitForFileExtraction") {
            const fileId = typeof args.fileId === "string"
              ? args.fileId
              : (typeof output.fileId === "string" ? output.fileId : null);
            if (fileId) {
              const attempts = receiptSearchProgress.extractionWaitAttempts[fileId] || 0;
              receiptSearchProgress.extractionWaitAttempts[fileId] = attempts + 1;
            }
            const extractionComplete = output.extractionComplete === true;
            const outputError = typeof output.error === "string" ? output.error : null;
            const nonTimeoutTerminalError = outputError && outputError.toLowerCase() !== "timeout";
            if (extractionComplete || nonTimeoutTerminalError) {
              markExtractionCompleted(receiptSearchProgress, fileId);
            }
          }

          if (toolName === "connectFileToTransaction") {
            if (output.success === true) {
              receiptSearchProgress.connectSuccessCount += 1;
            } else if (output.error) {
              receiptSearchProgress.connectFailureCount += 1;
            }
          }

          sequentialIndex += 1;
        }
      }

      return {
        ...result,
        toolCallCount: newToolCallCount,
        receiptSearchProgress,
      };
    } catch (error) {
      console.error(`[Worker:${workerType}] Tool execution error:`, error);
      throw error;
    }
  };
}

/**
 * Respond node - generates final response
 */
async function respondNode(state: WorkerState): Promise<Partial<WorkerState>> {
  return {
    shouldContinue: false,
  };
}

async function enforceReceiptGatesNode(state: WorkerState): Promise<Partial<WorkerState>> {
  if (state.workerType !== "receipt_search") {
    return {};
  }

  const gate = evaluateReceiptGate(state);
  if (gate.canFinalize) {
    return {};
  }

  const reminder = `Receipt-search gate: Continue with tool calls before finalizing.
Missing requirements:
- ${gate.unmet.join("\n- ")}
If you already have a perfect verified match, connect it; otherwise keep searching/validating.`;

  return {
    messages: [new SystemMessage(reminder)],
    receiptSearchEnforcementCount: (state.receiptSearchEnforcementCount || 0) + 1,
  };
}

// ============================================================================
// Routing
// ============================================================================

/**
 * Route after agent node
 */
function routeAfterAgent(state: WorkerState): "tools" | "respond" | "enforce" {
  const { messages, messageCount, toolCallCount, workerType } = state;
  const config = getWorkerConfig(workerType);
  const lastMessage = messages[messages.length - 1];

  // Check for runaway prevention - max messages
  if (messageCount >= config.maxMessages) {
    console.log(`[Worker:${workerType}] Max messages (${config.maxMessages}) reached, stopping`);
    return "respond";
  }

  // Check for runaway prevention - max tool calls
  if (toolCallCount >= config.maxToolCalls) {
    console.log(`[Worker:${workerType}] Max tool calls (${config.maxToolCalls}) reached, stopping`);
    return "respond";
  }

  // Check for tool calls

  const msgAny = lastMessage as any;
  const toolCalls = msgAny?.tool_calls || msgAny?.additional_kwargs?.tool_calls || [];

  if (!toolCalls.length) {
    if (workerType === "receipt_search") {
      const gate = evaluateReceiptGate(state);
      if (!gate.canFinalize && (state.receiptSearchEnforcementCount || 0) < 4) {
        console.log(
          `[Worker:${workerType}] Finalization blocked by receipt gates: ${gate.unmet.join(" | ")}`
        );
        return "enforce";
      }
    }
    return "respond";
  }

  console.log(`[Worker:${workerType}] Routing to tools: ${toolCalls.map((tc: { name: string }) => tc.name).join(", ")}`);
  return "tools";
}

/**
 * Route after tools node
 */
function routeAfterTools(state: WorkerState): "agent" | "respond" {
  const { messages, messageCount, toolCallCount, workerType } = state;
  const config = getWorkerConfig(workerType);
  const lastMessage = messages[messages.length - 1];

  // Check for runaway prevention - max messages
  if (messageCount >= config.maxMessages) {
    console.log(`[Worker:${workerType}] Max messages reached after tools, stopping`);
    return "respond";
  }

  // Check for runaway prevention - max tool calls
  if (toolCallCount >= config.maxToolCalls) {
    console.log(`[Worker:${workerType}] Max tool calls (${config.maxToolCalls}) reached after tools, stopping`);
    return "respond";
  }

  // If the last message is a tool message, continue to agent
  if (lastMessage instanceof ToolMessage) {
    return "agent";
  }

  return "respond";
}

// ============================================================================
// Graph Builder
// ============================================================================

/**
 * Build a worker graph for a specific worker type
 */
export function buildWorkerGraph(workerType: WorkerType) {
  console.log(`[WorkerGraph] Building graph for ${workerType}`);

  const toolsNode = createToolsNode(workerType);

  const graph = new StateGraph(WorkerStateAnnotation)
    .addNode("agent", agentNode)
    .addNode("tools", toolsNode)
    .addNode("enforce", enforceReceiptGatesNode)
    .addNode("respond", respondNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", routeAfterAgent, {
      tools: "tools",
      enforce: "enforce",
      respond: "respond",
    })
    .addConditionalEdges("tools", routeAfterTools, {
      agent: "agent",
      respond: "respond",
    })
    .addEdge("enforce", "agent")
    .addEdge("respond", END);

  return graph.compile();
}

// ============================================================================
// Helper to run the worker graph
// ============================================================================

export interface RunWorkerInput {
  messages: BaseMessage[];
  userId: string;
  authHeader: string;
  workerType: WorkerType;
  runId: string;
  modelProvider?: ModelProvider;
}

export interface RunWorkerOutput {
  messages: BaseMessage[];
  actionsPerformed: WorkerAction[];
}

/**
 * Run a worker graph
 */
export async function runWorkerGraph(input: RunWorkerInput): Promise<RunWorkerOutput> {
  const graph = buildWorkerGraph(input.workerType);
  const config = getWorkerConfig(input.workerType);

  // Set recursion limit based on worker config (each agent->tools cycle is ~2 steps)
  const recursionLimit = (config.maxMessages * 2) + 5;

  const result = await graph.invoke(
    {
      messages: input.messages,
      userId: input.userId,
      authHeader: input.authHeader,
      workerType: input.workerType,
      runId: input.runId,
      modelProvider: input.modelProvider || "gemini",
      messageCount: 0,
      toolCallCount: 0,
      shouldContinue: true,
      actionsPerformed: [],
      receiptSearchProgress: createInitialReceiptSearchProgress(),
      receiptSearchEnforcementCount: 0,
    },
    {
      recursionLimit,
    }
  );

  return {
    messages: result.messages,
    actionsPerformed: result.actionsPerformed || [],
  };
}

/**
 * Stream a worker graph execution
 */
export async function* streamWorkerGraph(
  input: RunWorkerInput,
  options: { streamMode?: "messages" | "values" } = {}
) {
  const graph = buildWorkerGraph(input.workerType);
  const config = getWorkerConfig(input.workerType);
  const recursionLimit = (config.maxMessages * 2) + 5;
  const streamMode = options.streamMode || "messages";

  const stream = await graph.stream(
    {
      messages: input.messages,
      userId: input.userId,
      authHeader: input.authHeader,
      workerType: input.workerType,
      runId: input.runId,
      modelProvider: input.modelProvider || "gemini",
      messageCount: 0,
      toolCallCount: 0,
      shouldContinue: true,
      actionsPerformed: [],
      receiptSearchProgress: createInitialReceiptSearchProgress(),
      receiptSearchEnforcementCount: 0,
    },
    {
      streamMode: [streamMode],
      recursionLimit,
    }
  );

  for await (const chunk of stream) {
    yield chunk;
  }
}
