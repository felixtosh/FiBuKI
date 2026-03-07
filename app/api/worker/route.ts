export const dynamic = "force-dynamic";
/**
 * Worker API Route
 *
 * Handles worker execution requests.
 * Workers run as independent LangGraph agents with restricted toolsets.
 */

import { NextResponse, after } from "next/server";
import { getServerUserIdWithFallback } from "@/lib/auth/get-server-user";
import { getAdminDb } from "@/lib/firebase/admin";
import { Timestamp, FieldValue } from "firebase-admin/firestore";
import { HumanMessage } from "@langchain/core/messages";
import { streamWorkerGraph } from "@/lib/agent/worker-graph";
import { getWorkerConfig } from "@/lib/agent/worker-configs";
import { WorkerType, WorkerMessage, WorkerRun, WorkerTriggerContext } from "@/types/worker";
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
  triggerContext?: WorkerTriggerContext;
  workerRequestId?: string;
  triggeredBy?: "auto" | "user";
  modelProvider?: ModelProvider;
}

interface WorkerExecutionResponse {
  runId: string;
  status: "running" | "completed" | "failed" | "blocked_for_reauth";
  summary?: string;
  actionsPerformed?: WorkerRun["actionsPerformed"];
  error?: string;
  errorCode?: string;
  retryAfterMs?: number;
  sessionId?: string;
  deduped?: boolean;
}

interface PartnerBatchStateDoc {
  userId: string;
  partnerId: string;
  status: "idle" | "pending" | "processing";
  activeRequestId: string | null;
  activeRunId: string | null;
  queuedFileIds: string[];
  inflightFileIds: string[];
  rerunNeeded: boolean;
  version: number;
  lastCompletedAt: Timestamp | null;
  nextEligibleAt: Timestamp | null;
  failureCount: number;
  lastSummary?: string | null;
  lastError?: string | null;
  createdAt: Timestamp;
  updatedAt: Timestamp;
}

interface PartnerBatchClaimResult {
  triggerContext: WorkerTriggerContext;
}

const PARTNER_BATCH_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes
const PARTNER_BATCH_FAILURE_BACKOFF_BASE_MS = 5 * 60 * 1000; // 5 minutes
const PARTNER_BATCH_FAILURE_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000; // 6 hours
const GMAIL_REAUTH_RETRY_DELAY_MS = 10 * 60 * 1000; // 10 minutes
const WORKER_DEDUPE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
const FIRESTORE_WRITE_RETRY_ATTEMPTS = 3;
const FIRESTORE_WRITE_RETRY_BASE_DELAY_MS = 250;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getErrorCode(err: unknown): number | string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const maybe = err as { code?: unknown };
  return typeof maybe.code === "number" || typeof maybe.code === "string"
    ? maybe.code
    : undefined;
}

function isTransientFirestoreWriteError(err: unknown): boolean {
  const code = getErrorCode(err);
  const message = err instanceof Error ? err.message : String(err);
  const upper = message.toUpperCase();

  return (
    code === 4 || // DEADLINE_EXCEEDED
    code === 10 || // ABORTED
    code === 14 || // UNAVAILABLE
    code === "DEADLINE_EXCEEDED" ||
    code === "ABORTED" ||
    code === "UNAVAILABLE" ||
    upper.includes("DEADLINE_EXCEEDED") ||
    upper.includes("UNAVAILABLE")
  );
}

async function withFirestoreWriteRetry<T>(
  label: string,
  fn: () => Promise<T>
): Promise<T> {
  let lastErr: unknown;

  for (let attempt = 1; attempt <= FIRESTORE_WRITE_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const isTransient = isTransientFirestoreWriteError(err);
      if (!isTransient || attempt === FIRESTORE_WRITE_RETRY_ATTEMPTS) {
        throw err;
      }
      const delayMs = FIRESTORE_WRITE_RETRY_BASE_DELAY_MS * attempt;
      console.warn(
        `[Worker API] ${label} failed on attempt ${attempt}/${FIRESTORE_WRITE_RETRY_ATTEMPTS}; retrying in ${delayMs}ms`,
        err
      );
      await sleep(delayMs);
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(`${label} failed`);
}

function isGmailReauthErrorMessage(message?: string): boolean {
  if (!message) return false;
  const lower = message.toLowerCase();
  return (
    lower.includes("auth_expired") ||
    lower.includes("token_expired") ||
    lower.includes("reauth_required") ||
    lower.includes("re-authentication required") ||
    lower.includes("reconnect gmail") ||
    lower.includes("tokens_missing") ||
    lower.includes("needs reconnection") ||
    lower.includes("needs reauth")
  );
}

function workerUsesGmail(config: { toolNames: string[] }): boolean {
  const gmailTools = new Set([
    "searchGmailAttachments",
    "searchGmailEmails",
    "analyzeEmail",
    "downloadGmailAttachment",
    "convertEmailToPdf",
  ]);
  return config.toolNames.some((toolName) => gmailTools.has(toolName));
}

async function getGmailReauthBlock(userId: string): Promise<{
  blocked: boolean;
  affectedEmails: string[];
}> {
  const integrationsSnap = await db
    .collection("emailIntegrations")
    .where("userId", "==", userId)
    .where("provider", "==", "gmail")
    .where("isActive", "==", true)
    .get();

  if (integrationsSnap.empty) {
    return { blocked: false, affectedEmails: [] };
  }

  const integrations = integrationsSnap.docs.map((doc) => doc.data() as {
    email?: string;
    needsReauth?: boolean;
  });
  const hasHealthyIntegration = integrations.some((integration) => integration.needsReauth !== true);

  if (hasHealthyIntegration) {
    return { blocked: false, affectedEmails: [] };
  }

  const affectedEmails = integrations
    .map((integration) => integration.email)
    .filter((email): email is string => typeof email === "string" && email.length > 0);

  return { blocked: true, affectedEmails };
}

async function requeueWorkerRequestForReauth(
  userId: string,
  workerRequestId: string | undefined,
  message: string,
  retryAfterMs: number
): Promise<void> {
  if (!workerRequestId) return;

  const requestRef = db.collection(`users/${userId}/workerRequests`).doc(workerRequestId);
  const requestSnap = await requestRef.get();
  if (!requestSnap.exists) return;

  await requestRef.set(
    {
      status: "pending",
      startedAt: null,
      completedAt: FieldValue.delete(),
      error: FieldValue.delete(),
      lastError: message,
      pauseReason: "reauth_required",
      notBeforeAt: Timestamp.fromMillis(Date.now() + retryAfterMs),
      updatedAt: Timestamp.now(),
    },
    { merge: true }
  );
}

async function createGmailReauthNotification(
  userId: string,
  affectedEmails: string[]
): Promise<void> {
  const now = Timestamp.now();
  const emailPreview = affectedEmails[0] || "your Gmail account";
  const message = `${emailPreview} needs reconnection. Automated matching is paused and will resume automatically once reconnected.`;
  const notificationRef = db
    .collection("notifications")
    .doc(`gmail_reauth_required_${userId}`);
  const notificationSnap = await notificationRef.get();

  await notificationRef.set({
    userId,
    type: "gmail_reauth_required",
    title: "Reconnect Gmail to Resume Matching",
    message,
    read: false, // re-open the reminder every time this condition recurs
    createdAt: notificationSnap.exists
      ? (notificationSnap.data()?.createdAt || now)
      : now,
    updatedAt: now,
  });
}

function normalizeStringArray(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const deduped = new Set<string>();
  for (const item of input) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (trimmed) deduped.add(trimmed);
  }
  return Array.from(deduped);
}

function cleanTriggerContext(triggerContext?: WorkerTriggerContext): WorkerTriggerContext | undefined {
  if (!triggerContext) return undefined;

  const cleaned: WorkerTriggerContext = {};
  if (triggerContext.fileId) cleaned.fileId = triggerContext.fileId;
  if (triggerContext.transactionId) cleaned.transactionId = triggerContext.transactionId;
  if (triggerContext.batchId) cleaned.batchId = triggerContext.batchId;
  if (triggerContext.partnerId) cleaned.partnerId = triggerContext.partnerId;

  const fileIds = normalizeStringArray(triggerContext.fileIds);
  if (fileIds.length > 0) cleaned.fileIds = fileIds;

  if (typeof triggerContext.topSuggestionConfidence === "number") {
    cleaned.topSuggestionConfidence = triggerContext.topSuggestionConfidence;
  }
  if (typeof triggerContext.triggeredAfterRuleBasedMatch === "boolean") {
    cleaned.triggeredAfterRuleBasedMatch = triggerContext.triggeredAfterRuleBasedMatch;
  }

  return Object.keys(cleaned).length > 0 ? cleaned : undefined;
}

function buildWorkerDedupeKey(
  workerType: WorkerType,
  triggerContext?: WorkerTriggerContext
): string | undefined {
  if (!triggerContext) return undefined;
  if (triggerContext.transactionId) return `${workerType}:tx:${triggerContext.transactionId}`;
  if (triggerContext.fileId) return `${workerType}:file:${triggerContext.fileId}`;
  if (triggerContext.partnerId) return `${workerType}:partner:${triggerContext.partnerId}`;
  return undefined;
}

function toMillis(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const maybe = value as { toMillis?: () => number };
  if (typeof maybe.toMillis === "function") return maybe.toMillis();
  return undefined;
}

async function findActiveRunByDedupeKey(
  userId: string,
  dedupeKey: string
): Promise<{ runId: string; sessionId?: string } | null> {
  const snap = await db
    .collection(`users/${userId}/workerRuns`)
    .where("dedupeKey", "==", dedupeKey)
    .limit(10)
    .get();

  if (snap.empty) return null;

  const nowMs = Date.now();
  const candidates = snap.docs
    .map((doc) => {
      const data = doc.data() as Partial<WorkerRun>;
      const startedAtMs = toMillis(data.startedAt);
      const createdAtMs = toMillis(data.createdAt);
      const freshnessMs = startedAtMs ?? createdAtMs ?? 0;
      return {
        runId: doc.id,
        status: data.status,
        sessionId: data.sessionId,
        freshnessMs,
      };
    })
    .filter(
      (run) =>
        run.status === "running" &&
        nowMs - run.freshnessMs <= WORKER_DEDUPE_WINDOW_MS
    )
    .sort((a, b) => b.freshnessMs - a.freshnessMs);

  if (candidates.length === 0) return null;
  const latest = candidates[0];
  return {
    runId: latest.runId,
    ...(latest.sessionId ? { sessionId: latest.sessionId } : {}),
  };
}

function buildPartnerBatchPrompt(partnerId: string, fileIds: string[]): string {
  const ids = normalizeStringArray(fileIds);
  const preview = ids.slice(0, 20).join(", ");
  const overflow = ids.length > 20 ? ` ... (+${ids.length - 20} more)` : "";
  return `Batch match ${ids.length} files for partner ${partnerId}. File IDs: ${preview}${overflow}`;
}

async function claimPartnerBatchRun(
  userId: string,
  runId: string,
  workerRequestId: string | undefined,
  requestedTriggerContext: WorkerTriggerContext | undefined
): Promise<PartnerBatchClaimResult> {
  const requestedPartnerId = requestedTriggerContext?.partnerId;
  if (!requestedPartnerId) {
    throw new Error("partner_file_batch requires triggerContext.partnerId");
  }

  const stateRef = db.collection(`users/${userId}/partnerBatchStates`).doc(requestedPartnerId);
  const requestsCol = db.collection(`users/${userId}/workerRequests`);
  const requestedFileIds = normalizeStringArray(requestedTriggerContext?.fileIds);

  let claimResult: PartnerBatchClaimResult | null = null;

  await db.runTransaction(async (tx) => {
    const now = Timestamp.now();
    const stateSnap = await tx.get(stateRef);
    const stateData = stateSnap.exists
      ? (stateSnap.data() as Partial<PartnerBatchStateDoc>)
      : null;

    if (stateData?.status === "processing" && stateData.activeRunId && stateData.activeRunId !== runId) {
      throw new Error(`Partner batch ${requestedPartnerId} is already processing`);
    }

    const queuedIds = normalizeStringArray(stateData?.queuedFileIds);
    const currentInflight = normalizeStringArray(stateData?.inflightFileIds);
    const inflightFileIds = queuedIds.length > 0
      ? queuedIds
      : (requestedFileIds.length > 0 ? requestedFileIds : currentInflight);

    if (inflightFileIds.length === 0) {
      throw new Error(`No fileIds available to process for partner ${requestedPartnerId}`);
    }

    const triggerContext: WorkerTriggerContext = {
      ...(requestedTriggerContext || {}),
      partnerId: requestedPartnerId,
      fileIds: inflightFileIds,
      fileId: requestedTriggerContext?.fileId || inflightFileIds[0],
    };

    const activeRequestId = workerRequestId || stateData?.activeRequestId || null;
    if (activeRequestId) {
      const requestRef = requestsCol.doc(activeRequestId);
      const requestSnap = await tx.get(requestRef);
      if (requestSnap.exists) {
        tx.set(requestRef, {
          triggerContext: cleanTriggerContext(triggerContext),
          updatedAt: now,
        }, { merge: true });
      }
    }

    if (stateSnap.exists) {
      tx.set(stateRef, {
        status: "processing",
        activeRequestId,
        activeRunId: runId,
        queuedFileIds: [],
        inflightFileIds,
        rerunNeeded: false,
        updatedAt: now,
        version: FieldValue.increment(1),
      }, { merge: true });
    } else {
      tx.set(stateRef, {
        userId,
        partnerId: requestedPartnerId,
        status: "processing",
        activeRequestId,
        activeRunId: runId,
        queuedFileIds: [],
        inflightFileIds,
        rerunNeeded: false,
        version: 1,
        lastCompletedAt: null,
        nextEligibleAt: null,
        failureCount: 0,
        createdAt: now,
        updatedAt: now,
      } satisfies PartnerBatchStateDoc);
    }

    claimResult = {
      triggerContext,
    };
  });

  if (!claimResult) {
    throw new Error("Failed to claim partner batch run");
  }

  return claimResult;
}

async function finalizePartnerBatchRun(
  userId: string,
  partnerId: string,
  runId: string,
  summary: string | undefined,
  error: string | undefined
): Promise<void> {
  const stateRef = db.collection(`users/${userId}/partnerBatchStates`).doc(partnerId);
  const requestsCol = db.collection(`users/${userId}/workerRequests`);

  await db.runTransaction(async (tx) => {
    const now = Timestamp.now();
    const stateSnap = await tx.get(stateRef);
    if (!stateSnap.exists) return;

    const stateData = stateSnap.data() as Partial<PartnerBatchStateDoc>;
    if (stateData.activeRunId && stateData.activeRunId !== runId) {
      return;
    }

    const queuedFileIds = normalizeStringArray(stateData.queuedFileIds);
    const inflightFileIds = normalizeStringArray(stateData.inflightFileIds);
    const needsRerun = Boolean(stateData.rerunNeeded) || queuedFileIds.length > 0;
    const isFailure = Boolean(error);
    const previousFailureCount = stateData.failureCount || 0;
    const nextFailureCount = isFailure ? previousFailureCount + 1 : 0;

    const waitMs = isFailure
      ? Math.min(
          PARTNER_BATCH_FAILURE_BACKOFF_MAX_MS,
          PARTNER_BATCH_FAILURE_BACKOFF_BASE_MS * Math.pow(2, Math.max(0, nextFailureCount - 1))
        )
      : PARTNER_BATCH_COOLDOWN_MS;
    const nextEligibleAt = Timestamp.fromMillis(now.toMillis() + waitMs);

    if (needsRerun) {
      const nextFileIds = queuedFileIds.length > 0 ? queuedFileIds : inflightFileIds;
      const nextReqRef = requestsCol.doc();
      tx.set(nextReqRef, {
        id: nextReqRef.id,
        workerType: "partner_file_batch",
        initialPrompt: buildPartnerBatchPrompt(partnerId, nextFileIds),
        triggerContext: cleanTriggerContext({
          partnerId,
          fileIds: nextFileIds,
          fileId: nextFileIds[0],
          triggeredAfterRuleBasedMatch: true,
        }),
        triggeredBy: "auto",
        status: "pending",
        notBeforeAt: nextEligibleAt,
        createdAt: now,
        updatedAt: now,
      });

      tx.set(stateRef, {
        status: "pending",
        activeRequestId: nextReqRef.id,
        activeRunId: null,
        queuedFileIds: nextFileIds,
        inflightFileIds: [],
        rerunNeeded: false,
        lastCompletedAt: now,
        nextEligibleAt,
        failureCount: nextFailureCount,
        lastSummary: summary || null,
        lastError: error || null,
        updatedAt: now,
        version: FieldValue.increment(1),
      }, { merge: true });
      return;
    }

    tx.set(stateRef, {
      status: "idle",
      activeRequestId: null,
      activeRunId: null,
      queuedFileIds: [],
      inflightFileIds: [],
      rerunNeeded: false,
      lastCompletedAt: now,
      nextEligibleAt,
      failureCount: nextFailureCount,
      lastSummary: summary || null,
      lastError: error || null,
      updatedAt: now,
      version: FieldValue.increment(1),
    }, { merge: true });
  });
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
  messages: any[],
  options: { idPrefix?: string } = {}
): WorkerMessage[] {
  const result: WorkerMessage[] = [];
  let fallbackIdCounter = 0;

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
      const hasResult = toolResults.has(tc.id);
      const toolCall: Record<string, unknown> = {
        id: tc.id,
        name: tc.name,
        args: truncateLargeResults(tc.args) as Record<string, unknown>,
        status: hasResult ? "executed" : "pending",
        requiresConfirmation: false,
      };
      if (hasResult) {
        toolCall.result = truncateLargeResults(toolResult);
      }

      parts.push({
        type: "tool",
        toolCall,
      });
    }

    // Skip empty messages
    if (!content && parts.length === 0) {
      continue;
    }

    const rawId = typeof msg.id === "string"
      ? msg.id
      : "";
    const sanitizedId = rawId.replace(/\//g, "_");
    const messageId = sanitizedId || `${options.idPrefix || "worker_msg"}_${++fallbackIdCounter}`;

    result.push({
      id: messageId,
      role: role as "user" | "assistant" | "system",
      content,
      parts: parts.length > 0 ? parts : undefined,
      createdAt: Timestamp.now(),
    });
  }

  return result;
}

function isSessionPersistableMessage(msg: WorkerMessage): boolean {
  if (!msg.parts || msg.parts.length === 0) return true;
  for (const part of msg.parts) {
    if (part.type !== "tool" || !("toolCall" in part)) continue;
    const toolCall = part.toolCall as { result?: unknown };
    if (!Object.prototype.hasOwnProperty.call(toolCall, "result")) {
      return false;
    }
  }
  return true;
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

  // Action tool labels (tools that mutate data)
  const ACTION_LABELS = new Set([
    "Connect file", "Connect files", "Download attachment", "Convert email",
    "Assign partner", "Create partner",
  ]);

  // Check if any action succeeded
  const actionTools = summaries.filter(s => ACTION_LABELS.has(s.label));
  const hasSuccessAction = actionTools.some(s => s.status === "success");

  // Search/lookup tools (everything that's not an action)
  const searchTools = summaries.filter(s => !ACTION_LABELS.has(s.label));

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
    return new Intl.NumberFormat("de-AT", { style: "currency", currency: curr }).format(Math.abs(amount) / 100);
  } catch {
    return `${(Math.abs(amount) / 100).toFixed(2)} ${curr}`;
  }
}

/**
 * Create an empty chat session for a worker run.
 * For user-triggered workers this is called upfront so "View in chat" works immediately.
 * For auto-triggered workers this is called after completion.
 */
async function createWorkerChatSession(
  userId: string,
  workerType: WorkerType,
  initialPrompt: string
): Promise<string> {
  const config = getWorkerConfig(workerType);

  const sessionRef = db.collection(`users/${userId}/chatSessions`).doc();
  await sessionRef.set({
    title: config.name,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    messageCount: 1,
    isWorkerSession: true,
    workerType,
  });

  // Add user prompt as first message
  await sessionRef.collection("messages").add({
    role: "user",
    content: initialPrompt,
    createdAt: FieldValue.serverTimestamp(),
    sequence: 1,
  });

  return sessionRef.id;
}

/**
 * Append worker transcript messages to an existing chat session.
 */
async function appendMessagesToSession(
  userId: string,
  sessionId: string,
  entries: Array<{ message: WorkerMessage; sequence: number }>,
  persistedMessageCount?: number
): Promise<void> {
  if (entries.length === 0) return;

  await withFirestoreWriteRetry(
    `appendMessagesToSession(${sessionId})`,
    async () => {
      const sessionRef = db.collection(`users/${userId}/chatSessions`).doc(sessionId);
      const batch = db.batch();
      const messagesRef = sessionRef.collection("messages");

      for (const { message, sequence } of entries) {
        const cleanParts = message.parts?.map(part => {
          const clean: Record<string, unknown> = { type: part.type };
          if ("text" in part) clean.text = part.text;
          if ("toolCall" in part) clean.toolCall = part.toolCall;
          return clean;
        });

        const messageRef = messagesRef.doc(message.id);
        batch.set(messageRef, {
          role: message.role,
          content: message.content || "",
          parts: cleanParts,
          createdAt: FieldValue.serverTimestamp(),
          sequence,
        });
      }

      const sessionUpdate: Record<string, unknown> = {
        updatedAt: FieldValue.serverTimestamp(),
      };
      if (typeof persistedMessageCount === "number") {
        sessionUpdate.messageCount = persistedMessageCount + 1; // +1 for initial user prompt
      }

      const lastContent = [...entries]
        .reverse()
        .map((entry) => entry.message.content?.trim())
        .find((content) => content);
      if (lastContent) {
        sessionUpdate.lastMessagePreview = lastContent.slice(0, 100);
      }

      batch.set(sessionRef, sessionUpdate, { merge: true });
      await batch.commit();
    }
  );
}

/**
 * Create a "starting" notification for a worker run
 * Returns the notification ID so it can be updated later
 */
async function createStartingNotification(
  userId: string,
  workerRun: Partial<WorkerRun>,
  sessionId?: string
): Promise<string> {
  const config = getWorkerConfig(workerRun.workerType!);

  const notificationContext: Record<string, unknown> = {
    workerRunId: workerRun.id,
    workerType: workerRun.workerType,
    workerStatus: "running",
  };

  if (sessionId) {
    notificationContext.sessionId = sessionId;
  }

  // Fetch file/transaction name for display during processing
  if (workerRun.triggerContext?.fileId) {
    notificationContext.fileId = workerRun.triggerContext.fileId;
    try {
      const fileDoc = await db.collection("files").doc(workerRun.triggerContext.fileId).get();
      if (fileDoc.exists) {
        const fileData = fileDoc.data()!;
        notificationContext.fileName = fileData.fileName || "Invoice";
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
      initialPrompt: rawPrompt,
      triggerContext,
      workerRequestId,
      triggeredBy = "user",
      modelProvider = "gemini",
    } = body;

    // Guard: initialPrompt must be a non-empty string (new HumanMessage(undefined) crashes)
    const initialPrompt = rawPrompt || `Run ${workerType} worker`;

    // Validate worker type
    const config = getWorkerConfig(workerType);
    if (!config) {
      return NextResponse.json(
        { error: `Unknown worker type: ${workerType}` },
        { status: 400 }
      );
    }

    if (workerUsesGmail(config)) {
      const gmailBlock = await getGmailReauthBlock(userId);
      if (gmailBlock.blocked) {
        const pauseMessage =
          "Paused: Gmail reconnection required. This worker will resume automatically after reconnect.";

        await requeueWorkerRequestForReauth(
          userId,
          workerRequestId,
          pauseMessage,
          GMAIL_REAUTH_RETRY_DELAY_MS
        );
        await createGmailReauthNotification(userId, gmailBlock.affectedEmails);

        return NextResponse.json({
          status: "blocked_for_reauth",
          error: pauseMessage,
          errorCode: "REAUTH_REQUIRED",
          retryAfterMs: GMAIL_REAUTH_RETRY_DELAY_MS,
        });
      }
    }

    console.log(`[Worker API] Starting ${workerType} worker for user ${userId}`);

    // Create WorkerRun document
    const runRef = db.collection(`users/${userId}/workerRuns`).doc();
    const runId = runRef.id;

    let effectiveTriggerContext = cleanTriggerContext(triggerContext);
    let effectiveInitialPrompt = initialPrompt;
    let dedupeKey = buildWorkerDedupeKey(workerType, effectiveTriggerContext);

    if (dedupeKey) {
      const activeDuplicate = await findActiveRunByDedupeKey(userId, dedupeKey);
      if (activeDuplicate) {
        console.log(
          `[Worker API] Reusing active run ${activeDuplicate.runId} for dedupeKey=${dedupeKey}`
        );
        return NextResponse.json({
          runId: activeDuplicate.runId,
          status: "running",
          ...(activeDuplicate.sessionId ? { sessionId: activeDuplicate.sessionId } : {}),
          deduped: true,
        } satisfies WorkerExecutionResponse);
      }
    }

    if (workerType === "partner_file_batch") {
      if (!effectiveTriggerContext?.partnerId) {
        return NextResponse.json(
          { error: "partner_file_batch requires triggerContext.partnerId" },
          { status: 400 }
        );
      }

      const claim = await claimPartnerBatchRun(
        userId,
        runId,
        workerRequestId,
        effectiveTriggerContext
      );

      effectiveTriggerContext = cleanTriggerContext(claim.triggerContext);
      effectiveInitialPrompt = buildPartnerBatchPrompt(
        effectiveTriggerContext!.partnerId!,
        effectiveTriggerContext!.fileIds || []
      );
      dedupeKey = buildWorkerDedupeKey(workerType, effectiveTriggerContext);
    }

    const initialRun: Partial<WorkerRun> = {
      id: runId,
      userId,
      workerType,
      status: "running",
      triggeredBy,
      triggerContext: effectiveTriggerContext,
      ...(dedupeKey ? { dedupeKey } : {}),
      messages: [],
      createdAt: Timestamp.now(),
      startedAt: Timestamp.now(),
    };

    // Remove undefined fields before saving to Firestore
    const runData = Object.fromEntries(
      Object.entries(initialRun).filter(([, v]) => v !== undefined)
    );

    await runRef.set(runData);

    // For user-triggered workers, create chat session upfront so "View in chat" works immediately
    let sessionId: string | undefined;
    if (triggeredBy === "user") {
      try {
        sessionId = await createWorkerChatSession(userId, workerType, effectiveInitialPrompt);
        await runRef.set({ sessionId }, { merge: true });
      } catch (err) {
        console.error(`[Worker API] Failed to create upfront chat session:`, err);
      }
    }

    // Create "starting" notification immediately so user sees activity
    let notificationId: string | undefined;
    try {
      notificationId = await createStartingNotification(userId, initialRun, sessionId);
    } catch (err) {
      console.error(`[Worker API] Failed to create starting notification:`, err);
    }

    const executeWorkerRun = async (): Promise<WorkerExecutionResponse> => {
      try {
        // Stream worker graph and persist transcript progress for user-triggered sessions.
        // This enables "View in chat" to show in-flight progress, not just final results.
        let latestGraphMessages: unknown[] = [new HumanMessage(effectiveInitialPrompt)];
        let latestActionsPerformed: WorkerRun["actionsPerformed"] = [];
        const persistedMessageIds = new Set<string>();
        const persistedMessagePhase = new Map<string, "pending" | "completed">();
        let incrementalSessionPersistenceEnabled = true;

        const persistReadySessionMessages = async (
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          allMessages: any[]
        ) => {
          if (!sessionId) return;
          const transcriptSoFar = convertToWorkerMessages(allMessages, { idPrefix: runId });
          const entriesToPersist = transcriptSoFar
            .map((message, index) => ({ message, sequence: index + 2 }))
            .filter(({ message }) => {
              const nextPhase: "pending" | "completed" = isSessionPersistableMessage(message)
                ? "completed"
                : "pending";
              const prevPhase = persistedMessagePhase.get(message.id);
              // Persist first sighting and any transition (pending -> completed).
              return prevPhase !== nextPhase;
            });

          if (entriesToPersist.length === 0) return;

          const uniqueMessageCount = new Set([
            ...persistedMessageIds,
            ...entriesToPersist.map(({ message }) => message.id),
          ]).size;

          await appendMessagesToSession(
            userId,
            sessionId,
            entriesToPersist,
            uniqueMessageCount
          );
          for (const { message } of entriesToPersist) {
            persistedMessageIds.add(message.id);
            persistedMessagePhase.set(
              message.id,
              isSessionPersistableMessage(message) ? "completed" : "pending"
            );
          }
        };

        for await (const chunk of streamWorkerGraph({
          messages: [new HumanMessage(effectiveInitialPrompt)],
          userId,
          authHeader,
          workerType,
          runId,
          modelProvider,
        }, { streamMode: "values" })) {
          if (!Array.isArray(chunk) || chunk[0] !== "values") continue;
          const state = chunk[1] as {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            messages?: any[];
            actionsPerformed?: WorkerRun["actionsPerformed"];
          };

          if (Array.isArray(state.messages)) {
            latestGraphMessages = state.messages;
            if (incrementalSessionPersistenceEnabled) {
              try {
                await persistReadySessionMessages(state.messages);
              } catch (err) {
                incrementalSessionPersistenceEnabled = false;
                console.warn(
                  `[Worker API] Disabling incremental session persistence for run ${runId} after write failure`,
                  err
                );
              }
            }
          }
          if (Array.isArray(state.actionsPerformed)) {
            latestActionsPerformed = state.actionsPerformed;
          }
        }

        // Convert final messages to WorkerMessages
        const transcript = convertToWorkerMessages(latestGraphMessages as any[], { idPrefix: runId });

        // Extract summary from last assistant message
        const lastAssistantMsg = transcript
          .filter((m) => m.role === "assistant")
          .pop();
        const summary = lastAssistantMsg?.content || undefined;

        if (workerType === "partner_file_batch" && effectiveTriggerContext?.partnerId) {
          try {
            await finalizePartnerBatchRun(
              userId,
              effectiveTriggerContext.partnerId,
              runId,
              summary,
              undefined
            );
          } catch (err) {
            console.error("[Worker API] Failed to finalize partner batch state (success):", err);
          }
        }

        // Update WorkerRun with results
        const completedRun: Partial<WorkerRun> = {
          status: "completed",
          messages: transcript,
          summary,
          actionsPerformed: latestActionsPerformed,
          completedAt: Timestamp.now(),
        };

        await runRef.update(completedRun);

        // Append transcript to existing session (user-triggered) or create new one (auto-triggered)
        if (transcript.length > 0) {
          try {
            let createdSessionDuringCompletion = false;
            if (!sessionId) {
              sessionId = await createWorkerChatSession(userId, workerType, effectiveInitialPrompt);
              createdSessionDuringCompletion = Boolean(sessionId);
            }

            if (createdSessionDuringCompletion && sessionId) {
              await runRef.set({ sessionId }, { merge: true });
            }

            if (sessionId) {
              const pendingEntries = transcript
                .map((message, index) => ({ message, sequence: index + 2 }))
                .filter(({ message }) => {
                  const nextPhase: "pending" | "completed" = isSessionPersistableMessage(message)
                    ? "completed"
                    : "pending";
                  const prevPhase = persistedMessagePhase.get(message.id);
                  return prevPhase !== nextPhase;
                });

              if (pendingEntries.length > 0) {
                const uniqueMessageCount = new Set([
                  ...persistedMessageIds,
                  ...pendingEntries.map(({ message }) => message.id),
                ]).size;

                await appendMessagesToSession(
                  userId,
                  sessionId,
                  pendingEntries,
                  uniqueMessageCount
                );
                for (const { message } of pendingEntries) {
                  persistedMessageIds.add(message.id);
                  persistedMessagePhase.set(
                    message.id,
                    isSessionPersistableMessage(message) ? "completed" : "pending"
                  );
                }
              }
            }
          } catch (err) {
            console.error(`[Worker API] Failed to save chat session transcript:`, err);
          }
        }

        // Update notification with success
        if (notificationId) {
          try {
            await updateWorkerNotification(userId, notificationId, {
              ...initialRun,
              ...completedRun,
            }, sessionId);
          } catch (err) {
            console.error("[Worker API] Failed to update success notification:", err);
          }
        }

        console.log(`[Worker API] ${workerType} worker completed: ${runId}`);

        return {
          runId,
          status: "completed",
          summary,
          actionsPerformed: latestActionsPerformed,
          ...(sessionId ? { sessionId } : {}),
        };
      } catch (error) {
        // Update WorkerRun with error
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        const isReauthError = isGmailReauthErrorMessage(errorMessage);
        const errorCode = isReauthError ? "REAUTH_REQUIRED" : undefined;

        if (workerType === "partner_file_batch" && effectiveTriggerContext?.partnerId) {
          try {
            await finalizePartnerBatchRun(
              userId,
              effectiveTriggerContext.partnerId,
              runId,
              undefined,
              errorMessage
            );
          } catch (err) {
            console.error("[Worker API] Failed to finalize partner batch state (failure):", err);
          }
        }

        const failedRun: Partial<WorkerRun> = {
          status: "failed",
          error: errorMessage,
          ...(errorCode ? { errorCode } : {}),
          completedAt: Timestamp.now(),
        };

        try {
          await runRef.update(failedRun);
        } catch (err) {
          console.error("[Worker API] Failed to persist failed run status:", err);
        }

        if (isReauthError) {
          await requeueWorkerRequestForReauth(
            userId,
            workerRequestId,
            "Paused: Gmail reconnection required. This worker will resume automatically after reconnect.",
            GMAIL_REAUTH_RETRY_DELAY_MS
          );
          await createGmailReauthNotification(userId, []);
        }

        // Update notification with failure
        if (notificationId) {
          try {
            await updateWorkerNotification(userId, notificationId, {
              ...initialRun,
              ...failedRun,
            }, sessionId);
          } catch (err) {
            console.error("[Worker API] Failed to update failure notification:", err);
          }
        }

        console.error(`[Worker API] ${workerType} worker failed:`, error);

        if (isReauthError) {
          return {
            runId,
            status: "blocked_for_reauth",
            error: "Paused: Gmail reconnection required. This worker will resume automatically after reconnect.",
            errorCode: "REAUTH_REQUIRED",
            retryAfterMs: GMAIL_REAUTH_RETRY_DELAY_MS,
            ...(sessionId ? { sessionId } : {}),
          };
        }

        return {
          runId,
          status: "failed",
          error: errorMessage,
          ...(errorCode ? { errorCode } : {}),
          ...(sessionId ? { sessionId } : {}),
        };
      }
    };

    const shouldRespondImmediately = triggeredBy === "user" && !workerRequestId;
    if (shouldRespondImmediately) {
      after(async () => {
        const result = await executeWorkerRun();
        console.log(`[Worker API] Async worker finished ${runId} with status=${result.status}`);
      });

      return NextResponse.json({
        runId,
        status: "running",
        ...(sessionId ? { sessionId } : {}),
      } satisfies WorkerExecutionResponse);
    }

    const result = await executeWorkerRun();
    return NextResponse.json(result);
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
