export const dynamic = "force-dynamic";
/**
 * Worker API Route
 *
 * Handles worker execution requests.
 * Workers run as independent LangGraph agents with restricted toolsets.
 */

import { NextResponse } from "next/server";
import { getServerUserIdWithFallback } from "@/lib/auth/get-server-user";
import { getAdminDb } from "@/lib/firebase/admin";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import { HumanMessage } from "@langchain/core/messages";
import { runWorkerGraph } from "@/lib/agent/worker-graph";
import { getWorkerConfig } from "@/lib/agent/worker-configs";
import { WorkerType, WorkerRunInput, WorkerMessage, WorkerRun } from "@/types/worker";
import { ToolCallSummary } from "@/types/notification";
import { TOOL_LABELS, SKIP_TOOLS, parseToolResult, cleanToolSummary } from "@/lib/tool-summary";
import { ModelProvider } from "@/lib/agent/model";

const db = getAdminDb();

export const maxDuration = 120; // 2 minutes for worker execution

// ============================================================================
// Types
// ============================================================================

interface WorkerRequest {
  workerType: WorkerType;
  initialPrompt: string;
  triggerContext?: {
    fileId?: string;
    transactionId?: string;
  };
  triggeredBy?: "auto" | "user";
  modelProvider?: ModelProvider;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Truncate large values in tool results to prevent Firestore size limit errors
 * Max document size is 1MB, so we truncate individual results to ~50KB
 */
function truncateLargeResults(value: unknown, maxSize = 50000): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    if (value.length > maxSize) {
      return value.slice(0, maxSize) + `... [truncated, ${value.length - maxSize} chars removed]`;
    }
    return value;
  }

  if (Array.isArray(value)) {
    // For arrays, truncate if too many items or items are large
    const truncated = value.slice(0, 20).map(item => truncateLargeResults(item, maxSize / 10));
    if (value.length > 20) {
      return [...truncated, `... and ${value.length - 20} more items`];
    }
    return truncated;
  }

  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Skip very large nested objects like extractedText
      if (k === "extractedText" && typeof v === "string" && v.length > 1000) {
        result[k] = v.slice(0, 1000) + "... [truncated]";
      } else {
        result[k] = truncateLargeResults(v, maxSize / 5);
      }
    }
    return result;
  }

  return value;
}

/**
 * Convert LangChain messages to WorkerMessages for storage
 * Properly matches tool calls with their results from ToolMessages
 */
function convertToWorkerMessages(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages: any[]
): WorkerMessage[] {
  const result: WorkerMessage[] = [];

  // First pass: collect all tool results by tool_call_id
  const toolResults = new Map<string, unknown>();
  for (const msg of messages) {
    if (!msg) continue;
    const msgType = msg._getType?.() || msg.type;
    if (msgType === "tool") {
      const toolCallId = msg.tool_call_id || msg.additional_kwargs?.tool_call_id;
      if (toolCallId) {
        // Parse content if it's a JSON string
        let resultContent = msg.content;
        if (typeof resultContent === "string") {
          try {
            resultContent = JSON.parse(resultContent);
          } catch {
            // Keep as string if not valid JSON
          }
        }
        toolResults.set(toolCallId, resultContent);
      }
    }
  }

  // Second pass: build messages with tool results included
  for (const msg of messages) {
    if (!msg) continue;
    const msgType = msg._getType?.() || msg.type;

    // Skip system, tool, and human messages
    // (tool results are embedded in tool calls, human prompt is added separately)
    if (msgType === "system" || msgType === "tool" || msgType === "human") {
      continue;
    }

    const role = msgType === "human" ? "user" : msgType === "ai" ? "assistant" : "system";

    // Get content
    let content = "";
    if (typeof msg.content === "string") {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      content = msg.content
        .filter((c: { type: string }) => c.type === "text")
        .map((c: { text: string }) => c.text || "")
        .join("");
    }

    // Build parts from tool calls (with results)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const parts: any[] = [];

    // Add text part if present
    if (content) {
      parts.push({ type: "text", text: content });
    }

    // Add tool call parts with their results (truncate to prevent Firestore size limits)
    const toolCallsRaw = msg.tool_calls || msg.additional_kwargs?.tool_calls || [];
    const toolCalls = Array.isArray(toolCallsRaw) ? toolCallsRaw : [];
    for (const tc of toolCalls) {
      const toolResult = toolResults.get(tc.id);
      parts.push({
        type: "tool",
        toolCall: {
          id: tc.id,
          name: tc.name,
          args: truncateLargeResults(tc.args) as Record<string, unknown>,
          result: truncateLargeResults(toolResult),
          status: "executed",
          requiresConfirmation: false,
        },
      });
    }

    // Skip empty messages
    if (!content && parts.length === 0) {
      continue;
    }

    result.push({
      id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      role: role as "user" | "assistant" | "system",
      content,
      parts: parts.length > 0 ? parts : undefined,
      createdAt: Timestamp.now(),
    });
  }

  return result;
}

/**
 * Build a structured tool summary from worker transcript
 */
function buildToolSummary(transcript: WorkerMessage[]): ToolCallSummary[] {
  const summaries: ToolCallSummary[] = [];

  for (const msg of transcript) {
    if (!msg.parts) continue;
    for (const part of msg.parts) {
      if (part.type !== "tool" || !("toolCall" in part)) continue;
      const tc = (part as { toolCall: { id: string; name: string; args: Record<string, unknown>; result?: unknown } }).toolCall;
      if (!tc || SKIP_TOOLS.has(tc.name)) continue;

      const label = TOOL_LABELS[tc.name] || tc.name;
      const parsed = parseToolResult(tc.result);
      summaries.push(cleanToolSummary(label, parsed));
    }
  }

  return summaries;
}

/**
 * Build a compact notification message from tool summaries
 */
function buildCompactMessage(summaries: ToolCallSummary[]): string {
  if (summaries.length === 0) return "No actions performed";

  // Check if any action succeeded (connect/download/assign)
  const actionTools = summaries.filter(s =>
    s.label === "Connect file" || s.label === "Download attachment" || s.label === "Assign partner"
  );
  const hasSuccessAction = actionTools.some(s => s.status === "success");

  // Build search results line
  const searchTools = summaries.filter(s =>
    s.label === "Local files" || s.label === "Gmail attachments" || s.label === "Gmail messages"
  );

  const parts: string[] = [];
  for (const s of searchTools) {
    parts.push(`${s.label}: ${s.outcome}`);
  }

  if (hasSuccessAction) {
    const successAction = actionTools.find(s => s.status === "success");
    if (successAction) {
      parts.push(successAction.outcome === "Done" ? successAction.label : `${successAction.label}: ${successAction.outcome}`);
    }
  } else if (searchTools.length > 0 && !hasSuccessAction) {
    parts.push("No match");
  }

  return parts.join(" · ");
}

/**
 * Format amount with currency for notification title
 */
function formatAmount(amount: number, currency?: string): string {
  const curr = currency || "EUR";
  try {
    return new Intl.NumberFormat("de-AT", { style: "currency", currency: curr }).format(Math.abs(amount));
  } catch {
    return `${Math.abs(amount).toFixed(2)} ${curr}`;
  }
}

/**
 * Create a chat session from worker transcript
 * This allows users to view the worker's reasoning via "View in chat"
 */
async function createChatSessionFromTranscript(
  userId: string,
  workerType: WorkerType,
  transcript: WorkerMessage[],
  initialPrompt: string
): Promise<string> {
  const config = getWorkerConfig(workerType);

  // Create session document
  const sessionRef = db.collection(`users/${userId}/chatSessions`).doc();
  await sessionRef.set({
    title: config.name,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    messageCount: transcript.length + 1, // +1 for user prompt
    isWorkerSession: true,
    workerType,
  });

  // Add user prompt as first message
  const messagesRef = sessionRef.collection("messages");
  await messagesRef.add({
    role: "user",
    content: initialPrompt,
    createdAt: FieldValue.serverTimestamp(),
  });

  // Add transcript messages (assistant responses only, user prompt already added above)
  for (const msg of transcript) {
    // Filter out undefined values from parts
    const cleanParts = msg.parts?.map(part => {
      const clean: Record<string, unknown> = { type: part.type };
      if ("text" in part) clean.text = part.text;
      if ("toolCall" in part) clean.toolCall = part.toolCall;
      return clean;
    });

    await messagesRef.add({
      role: msg.role,
      content: msg.content || "",
      parts: cleanParts,
      createdAt: FieldValue.serverTimestamp(),
    });
  }

  return sessionRef.id;
}

/**
 * Create a "starting" notification for a worker run
 * Returns the notification ID so it can be updated later
 */
async function createStartingNotification(
  userId: string,
  workerRun: Partial<WorkerRun>
): Promise<string> {
  const config = getWorkerConfig(workerRun.workerType!);

  const notificationContext: Record<string, unknown> = {
    workerRunId: workerRun.id,
    workerType: workerRun.workerType,
    workerStatus: "running",
  };

  // Fetch file/transaction name for display during processing
  if (workerRun.triggerContext?.fileId) {
    notificationContext.fileId = workerRun.triggerContext.fileId;
    try {
      const fileDoc = await db.collection("files").doc(workerRun.triggerContext.fileId).get();
      if (fileDoc.exists) {
        const fileData = fileDoc.data()!;
        notificationContext.fileName = fileData.extractedPartner || fileData.fileName || "Invoice";
      }
    } catch (err) {
      console.warn("[Worker API] Failed to fetch file name:", err);
    }
  }
  if (workerRun.triggerContext?.transactionId) {
    notificationContext.transactionId = workerRun.triggerContext.transactionId;
    try {
      const txDoc = await db.collection("transactions").doc(workerRun.triggerContext.transactionId).get();
      if (txDoc.exists) {
        const txData = txDoc.data()!;
        notificationContext.transactionName = txData.name || "Transaction";
        if (txData.amount !== undefined) {
          notificationContext.transactionAmount = txData.amount;
        }
        if (txData.currency) {
          notificationContext.transactionCurrency = txData.currency;
        }
      }
    } catch (err) {
      console.warn("[Worker API] Failed to fetch transaction name:", err);
    }
  }

  const notificationRef = db.collection(`users/${userId}/notifications`).doc();
  await notificationRef.set({
    type: "worker_activity",
    title: `${config.name} running...`,
    message: "Searching for matches...",
    createdAt: FieldValue.serverTimestamp(),
    readAt: null,
    context: notificationContext,
  });

  return notificationRef.id;
}

/**
 * Update an existing notification with final status
 */
async function updateWorkerNotification(
  userId: string,
  notificationId: string,
  workerRun: Partial<WorkerRun>,
  sessionId?: string
): Promise<void> {
  const config = getWorkerConfig(workerRun.workerType!);

  // Build tool summary from transcript
  const toolSummary = workerRun.messages ? buildToolSummary(workerRun.messages) : [];

  // Fetch transaction context for title enrichment
  let txName: string | undefined;
  let txAmount: number | undefined;
  let txCurrency: string | undefined;

  const txId = workerRun.triggerContext?.transactionId;
  if (txId) {
    try {
      const txDoc = await db.collection("transactions").doc(txId).get();
      if (txDoc.exists) {
        const txData = txDoc.data()!;
        txName = txData.name;
        txAmount = txData.amount;
        txCurrency = txData.currency;
      }
    } catch {
      // Non-critical, fall back to generic title
    }
  }

  // Build title and message based on outcome
  let title: string;
  let message: string;

  if (workerRun.status === "completed") {
    // Rich title with transaction context
    const titlePrefix = config.name;
    if (txName) {
      const amountStr = txAmount !== undefined ? ` · ${formatAmount(txAmount, txCurrency)}` : "";
      title = `${titlePrefix}: ${txName}${amountStr}`;
    } else {
      title = titlePrefix;
    }

    // Compact message from tool summaries
    if (toolSummary.length > 0) {
      message = buildCompactMessage(toolSummary);
    } else {
      const actionsCount = workerRun.actionsPerformed?.length || 0;
      message = actionsCount > 0
        ? `Performed ${actionsCount} action${actionsCount !== 1 ? "s" : ""}`
        : "No actions needed";
    }
  } else if (workerRun.status === "failed") {
    title = `${config.name} failed`;
    message = workerRun.error || "An error occurred";
  } else {
    title = `${config.name} ${workerRun.status}`;
    message = workerRun.summary || "";
  }

  const updateData: Record<string, unknown> = {
    title,
    message,
    "context.workerStatus": workerRun.status,
    "context.actionsPerformed": workerRun.actionsPerformed?.length || 0,
  };

  if (sessionId) {
    updateData["context.sessionId"] = sessionId;
  }
  if (toolSummary.length > 0) {
    updateData["context.toolSummary"] = toolSummary;
  }
  if (txAmount !== undefined) {
    updateData["context.transactionAmount"] = txAmount;
  }
  if (txCurrency) {
    updateData["context.transactionCurrency"] = txCurrency;
  }

  await db.collection(`users/${userId}/notifications`).doc(notificationId).update(updateData);
}

// ============================================================================
// API Handler
// ============================================================================

export async function POST(req: Request) {
  try {
    const authHeader = req.headers.get("Authorization") || "";
    const userId = await getServerUserIdWithFallback(req);
    const body: WorkerRequest = await req.json();

    const {
      workerType,
      initialPrompt,
      triggerContext,
      triggeredBy = "user",
      modelProvider = "gemini",
    } = body;

    // Validate worker type
    const config = getWorkerConfig(workerType);
    if (!config) {
      return NextResponse.json(
        { error: `Unknown worker type: ${workerType}` },
        { status: 400 }
      );
    }

    console.log(`[Worker API] Starting ${workerType} worker for user ${userId}`);

    // Create WorkerRun document
    const runRef = db.collection(`users/${userId}/workerRuns`).doc();
    const runId = runRef.id;

    // Build triggerContext, excluding undefined values (Firestore doesn't accept undefined)
    const cleanTriggerContext: Record<string, string> = {};
    if (triggerContext?.fileId) {
      cleanTriggerContext.fileId = triggerContext.fileId;
    }
    if (triggerContext?.transactionId) {
      cleanTriggerContext.transactionId = triggerContext.transactionId;
    }

    const initialRun: Partial<WorkerRun> = {
      id: runId,
      userId,
      workerType,
      status: "running",
      triggeredBy,
      triggerContext: Object.keys(cleanTriggerContext).length > 0 ? cleanTriggerContext : undefined,
      messages: [],
      createdAt: Timestamp.now(),
      startedAt: Timestamp.now(),
    };

    // Remove undefined fields before saving to Firestore
    const runData = Object.fromEntries(
      Object.entries(initialRun).filter(([, v]) => v !== undefined)
    );

    await runRef.set(runData);

    // Create "starting" notification immediately so user sees activity
    let notificationId: string | undefined;
    try {
      notificationId = await createStartingNotification(userId, initialRun);
    } catch (err) {
      console.error(`[Worker API] Failed to create starting notification:`, err);
    }

    try {
      // Run the worker graph
      const result = await runWorkerGraph({
        messages: [new HumanMessage(initialPrompt)],
        userId,
        authHeader,
        workerType,
        runId,
        modelProvider,
      });

      // Convert messages to WorkerMessages
      const transcript = convertToWorkerMessages(result.messages);

      // Extract summary from last assistant message
      const lastAssistantMsg = transcript
        .filter((m) => m.role === "assistant")
        .pop();
      const summary = lastAssistantMsg?.content || undefined;

      // Update WorkerRun with results
      const completedRun: Partial<WorkerRun> = {
        status: "completed",
        messages: transcript,
        summary,
        actionsPerformed: result.actionsPerformed,
        completedAt: Timestamp.now(),
      };

      await runRef.update(completedRun);

      // Create chat session from transcript so user can "View in chat"
      let sessionId: string | undefined;
      if (transcript.length > 0) {
        try {
          sessionId = await createChatSessionFromTranscript(
            userId,
            workerType,
            transcript,
            initialPrompt
          );
        } catch (err) {
          console.error(`[Worker API] Failed to create chat session:`, err);
        }
      }

      // Update notification with success
      if (notificationId) {
        await updateWorkerNotification(userId, notificationId, {
          ...initialRun,
          ...completedRun,
        }, sessionId);
      }

      console.log(`[Worker API] ${workerType} worker completed: ${runId}`);

      return NextResponse.json({
        runId,
        status: "completed",
        summary,
        actionsPerformed: result.actionsPerformed,
      });
    } catch (error) {
      // Update WorkerRun with error
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      const failedRun: Partial<WorkerRun> = {
        status: "failed",
        error: errorMessage,
        completedAt: Timestamp.now(),
      };

      await runRef.update(failedRun);

      // Update notification with failure
      if (notificationId) {
        await updateWorkerNotification(userId, notificationId, {
          ...initialRun,
          ...failedRun,
        });
      }

      console.error(`[Worker API] ${workerType} worker failed:`, error);

      return NextResponse.json({
        runId,
        status: "failed",
        error: errorMessage,
      });
    }
  } catch (error) {
    console.error("[Worker API] Request failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Request failed" },
      { status: 500 }
    );
  }
}

/**
 * Get worker run status
 */
export async function GET(req: Request) {
  try {
    const userId = await getServerUserIdWithFallback(req);
    const { searchParams } = new URL(req.url);
    const runId = searchParams.get("runId");

    if (!runId) {
      return NextResponse.json(
        { error: "runId is required" },
        { status: 400 }
      );
    }

    const runDoc = await db
      .collection(`users/${userId}/workerRuns`)
      .doc(runId)
      .get();

    if (!runDoc.exists) {
      return NextResponse.json(
        { error: "Worker run not found" },
        { status: 404 }
      );
    }

    return NextResponse.json(runDoc.data());
  } catch (error) {
    console.error("[Worker API] GET failed:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Request failed" },
      { status: 500 }
    );
  }
}
