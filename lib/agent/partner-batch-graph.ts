/**
 * Partner Batch Graph
 *
 * LangGraph implementation for batch-processing multiple unmatched files
 * for a single partner. Searches once, scores NxM, connects optimally.
 *
 * Graph structure:
 * START → loadContext → planStrategy → searchPhase → scoreAndMatch
 *       → compactContext → (loop back to planStrategy OR reportResults) → END
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
import { StructuredToolInterface } from "@langchain/core/tools";
import { ALL_TOOLS } from "./tools";
import { getWorkerConfig } from "./worker-configs";
import { createChatModel, ModelProvider } from "./model";
import { WorkerAction } from "@/types/worker";

// ============================================================================
// State
// ============================================================================

interface BatchItem {
  fileId: string;
  fileName: string;
  extractedAmount?: number;
  extractedDate?: string;
  topSuggestion?: { transactionId: string; confidence: number };
  status: "pending" | "matched" | "failed" | "skipped";
  matchedTransactionId?: string;
  matchConfidence?: number;
  failReason?: string;
}

const PartnerBatchStateAnnotation = Annotation.Root({
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
  partnerId: Annotation<string>({
    reducer: (_, next) => next,
    default: () => "",
  }),
  partnerName: Annotation<string>({
    reducer: (_, next) => next,
    default: () => "",
  }),
  fileIds: Annotation<string[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),
  modelProvider: Annotation<ModelProvider>({
    reducer: (_, next) => next,
    default: () => "gemini" as ModelProvider,
  }),
  batchItems: Annotation<BatchItem[]>({
    reducer: (_, next) => next,
    default: () => [],
  }),
  contextSummary: Annotation<string>({
    reducer: (_, next) => next,
    default: () => "",
  }),
  cycleCount: Annotation<number>({
    reducer: (_, next) => next,
    default: () => 0,
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
});

type PartnerBatchState = typeof PartnerBatchStateAnnotation.State;

// ============================================================================
// Constants
// ============================================================================

const MAX_CYCLES = 3; // Max search→score→match cycles before giving up
const BATCH_WORKER_TYPE = "partner_file_batch" as const;

// ============================================================================
// Tool Filtering
// ============================================================================

function getBatchTools(): StructuredToolInterface[] {
  const config = getWorkerConfig(BATCH_WORKER_TYPE);
  const allowedTools = new Set(config.toolNames);
  return ALL_TOOLS.filter((tool) => allowedTools.has(tool.name));
}

// ============================================================================
// Graph Nodes
// ============================================================================

/**
 * Agent node - LLM decides what to do next
 */
async function agentNode(state: PartnerBatchState): Promise<Partial<PartnerBatchState>> {
  const { messages, modelProvider } = state;
  const config = getWorkerConfig(BATCH_WORKER_TYPE);

  const tools = getBatchTools();
  const model = await createChatModel({ provider: modelProvider }, tools);

  const systemPrompt = buildBatchSystemPrompt(state);
  const hasSystem = messages.some((m) => m instanceof SystemMessage);
  const messagesWithSystem = hasSystem
    ? messages
    : [new SystemMessage(systemPrompt), ...messages];

  const response = await model.invoke(messagesWithSystem, {
    configurable: {
      userId: state.userId,
      authHeader: state.authHeader,
    },
  });

  return {
    messages: [response],
    messageCount: state.messageCount + 1,
  };
}

/**
 * Tools node - execute tool calls
 */
function createBatchToolsNode() {
  const tools = getBatchTools();
  const rawToolsNode = new ToolNode(tools);

  return async function toolsNode(
    state: PartnerBatchState,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    config?: any
  ): Promise<Partial<PartnerBatchState>> {
    const toolConfig = {
      ...config,
      configurable: {
        ...config?.configurable,
        userId: state.userId,
        authHeader: state.authHeader,
      },
    };

    const result = await rawToolsNode.invoke(state, toolConfig);
    const newToolCalls = result.messages?.length || 0;

    return {
      ...result,
      toolCallCount: state.toolCallCount + newToolCalls,
    };
  };
}

/**
 * Context compacting node - trim messages, summarize progress
 */
async function compactContextNode(
  state: PartnerBatchState
): Promise<Partial<PartnerBatchState>> {
  const { messages, batchItems, cycleCount } = state;

  const pendingItems = batchItems.filter((i) => i.status === "pending");
  const matchedItems = batchItems.filter((i) => i.status === "matched");
  const failedItems = batchItems.filter((i) => i.status === "failed" || i.status === "skipped");

  const summary =
    `Cycle ${cycleCount + 1} complete. ` +
    `${matchedItems.length} matched, ${failedItems.length} failed/skipped, ${pendingItems.length} pending.\n` +
    matchedItems.map((i) => `  ✓ ${i.fileName} → tx ${i.matchedTransactionId} (${i.matchConfidence}%)`).join("\n") +
    (failedItems.length > 0
      ? "\n" + failedItems.map((i) => `  ✗ ${i.fileName}: ${i.failReason || "no match"}`).join("\n")
      : "") +
    (pendingItems.length > 0
      ? "\n" + pendingItems.map((i) => `  ? ${i.fileName}: still pending`).join("\n")
      : "");

  // Keep only system prompt + summary + last 3 messages
  const systemMsg = messages.find((m) => m instanceof SystemMessage);
  const recentMessages = messages.slice(-3);
  const compactedMessages: BaseMessage[] = [
    ...(systemMsg ? [systemMsg] : []),
    new HumanMessage(`Context from previous cycle:\n${summary}`),
    ...recentMessages.filter((m) => !(m instanceof SystemMessage)),
  ];

  return {
    messages: compactedMessages,
    contextSummary: summary,
    cycleCount: cycleCount + 1,
    shouldContinue: pendingItems.length > 0 && cycleCount + 1 < MAX_CYCLES,
  };
}

/**
 * Report results node
 */
async function reportResultsNode(
  state: PartnerBatchState
): Promise<Partial<PartnerBatchState>> {
  const { batchItems } = state;
  const matchedItems = batchItems.filter((i) => i.status === "matched");

  const actions: WorkerAction[] = matchedItems.map((i) => ({
    action: "connectFileToTransaction",
    targetId: `${i.fileId}→${i.matchedTransactionId}`,
    result: "success" as const,
    details: `${i.fileName} matched at ${i.matchConfidence}%`,
  }));

  return {
    shouldContinue: false,
    actionsPerformed: actions,
  };
}

// ============================================================================
// Routing
// ============================================================================

function routeAfterAgent(state: PartnerBatchState): "tools" | "compact" {
  const { messages, messageCount, toolCallCount } = state;
  const config = getWorkerConfig(BATCH_WORKER_TYPE);
  const lastMessage = messages[messages.length - 1];

  if (messageCount >= config.maxMessages || toolCallCount >= config.maxToolCalls) {
    return "compact";
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const msgAny = lastMessage as any;
  const toolCalls = msgAny?.tool_calls || msgAny?.additional_kwargs?.tool_calls || [];

  if (!toolCalls.length) {
    return "compact";
  }

  return "tools";
}

function routeAfterTools(state: PartnerBatchState): "agent" | "compact" {
  const { messageCount, toolCallCount } = state;
  const config = getWorkerConfig(BATCH_WORKER_TYPE);

  if (messageCount >= config.maxMessages || toolCallCount >= config.maxToolCalls) {
    return "compact";
  }

  return "agent";
}

function routeAfterCompact(state: PartnerBatchState): "agent" | "report" {
  return state.shouldContinue ? "agent" : "report";
}

// ============================================================================
// System Prompt
// ============================================================================

function buildBatchSystemPrompt(state: PartnerBatchState): string {
  const { partnerId, partnerName, fileIds, batchItems, contextSummary } = state;

  return `You are a batch file matcher for partner "${partnerName}" (ID: ${partnerId}).

You have ${fileIds.length} unmatched files for this partner. Your goal is to find the correct transaction match for each file.

## Strategy

1. First call loadPartnerBatchContext to understand all files and available transactions.
2. Plan your search strategy based on partner's emailDomains, fileSourcePatterns, and billingCycle.
3. Search ONCE for the whole partner (Gmail and/or local files) — don't repeat searches per file.
4. Use scoreBatchMatches to score all potential file↔transaction pairs at once.
5. Use bulkConnectFiles for high-confidence matches (≥85%).
6. Use updateBatchTaskList to track what you've resolved.

## Key Rules

- Search ONCE per source, not per file — this is a batch operation.
- For files with existing suggestions ≥70%, validate those first before searching.
- Respect the billingCycle data if available — it tells you expected invoice-to-transaction delays.
- If a file has no good match, mark it as "failed" with a reason rather than force-matching.
- Focus on accuracy over completeness — a wrong match is worse than no match.

${contextSummary ? `## Previous Context\n${contextSummary}\n` : ""}
${batchItems.length > 0 ? `## Current Status\n${batchItems.map((i) => `- ${i.fileName}: ${i.status}${i.failReason ? ` (${i.failReason})` : ""}`).join("\n")}\n` : ""}`;
}

// ============================================================================
// Graph Builder
// ============================================================================

export function buildPartnerBatchGraph() {
  const toolsNode = createBatchToolsNode();

  const graph = new StateGraph(PartnerBatchStateAnnotation)
    .addNode("agent", agentNode)
    .addNode("tools", toolsNode)
    .addNode("compact", compactContextNode)
    .addNode("report", reportResultsNode)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", routeAfterAgent, {
      tools: "tools",
      compact: "compact",
    })
    .addConditionalEdges("tools", routeAfterTools, {
      agent: "agent",
      compact: "compact",
    })
    .addConditionalEdges("compact", routeAfterCompact, {
      agent: "agent",
      report: "report",
    })
    .addEdge("report", END);

  return graph.compile();
}

// ============================================================================
// Runner
// ============================================================================

export interface RunPartnerBatchInput {
  userId: string;
  authHeader: string;
  runId: string;
  partnerId: string;
  partnerName: string;
  fileIds: string[];
  modelProvider?: ModelProvider;
}

export interface RunPartnerBatchOutput {
  messages: BaseMessage[];
  actionsPerformed: WorkerAction[];
  batchItems: BatchItem[];
}

export async function runPartnerBatchGraph(
  input: RunPartnerBatchInput
): Promise<RunPartnerBatchOutput> {
  const graph = buildPartnerBatchGraph();
  const config = getWorkerConfig(BATCH_WORKER_TYPE);
  const recursionLimit = (config.maxMessages * 2) + 10; // Extra room for compact cycles

  const initialMessage = new HumanMessage(
    `Batch match ${input.fileIds.length} files for partner "${input.partnerName}" (${input.partnerId}). ` +
    `File IDs: ${input.fileIds.join(", ")}`
  );

  const result = await graph.invoke(
    {
      messages: [initialMessage],
      userId: input.userId,
      authHeader: input.authHeader,
      runId: input.runId,
      partnerId: input.partnerId,
      partnerName: input.partnerName,
      fileIds: input.fileIds,
      modelProvider: input.modelProvider || "gemini",
      batchItems: input.fileIds.map((id) => ({
        fileId: id,
        fileName: id, // Will be updated by loadPartnerBatchContext
        status: "pending" as const,
      })),
      contextSummary: "",
      cycleCount: 0,
      messageCount: 0,
      toolCallCount: 0,
      shouldContinue: true,
      actionsPerformed: [],
    },
    { recursionLimit }
  );

  return {
    messages: result.messages,
    actionsPerformed: result.actionsPerformed || [],
    batchItems: result.batchItems || [],
  };
}
