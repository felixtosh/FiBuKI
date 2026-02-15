import {
  collection,
  query,
  orderBy,
  where,
  getDocs,
  getDoc,
  doc,
  updateDoc,
  addDoc,
  deleteDoc,
  Timestamp,
  limit,
} from "firebase/firestore";
import { ChatSession, ChatMessage, ToolCall, ToolResult } from "@/types/chat";
import { OperationsContext } from "./types";

const CHAT_SESSIONS_COLLECTION = "chatSessions";

// Max size for tool results to avoid Firestore rules memory limits
const MAX_TOOL_RESULT_SIZE = 50000; // ~50KB per result

/**
 * Truncate large tool results to prevent Firestore rules memory overflow
 */
/**
 * Recursively remove undefined values from an object (Firestore doesn't accept undefined)
 */
function stripUndefined<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => stripUndefined(item)) as T;
  }

  if (typeof obj === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (value !== undefined) {
        result[key] = stripUndefined(value);
      }
    }
    return result as T;
  }

  return obj;
}

function sanitizeMessageForStorage(message: Omit<ChatMessage, "id" | "createdAt">): Omit<ChatMessage, "id" | "createdAt"> {
  // First strip undefined values to prevent Firestore errors
  let sanitized = stripUndefined(message as Record<string, unknown>) as Omit<ChatMessage, "id" | "createdAt">;

  if (!sanitized.toolResults || sanitized.toolResults.length === 0) {
    return sanitized;
  }

  const sanitizedResults = sanitized.toolResults.map((result) => {
    const resultStr = JSON.stringify(result.result);
    if (resultStr.length > MAX_TOOL_RESULT_SIZE) {
      console.warn(`[chat-ops] Truncating large tool result for ${result.toolCallId} (${resultStr.length} bytes)`);
      return {
        ...result,
        result: {
          truncated: true,
          originalSize: resultStr.length,
          preview: resultStr.slice(0, 1000) + "...",
          message: "Result truncated due to size limits",
        },
      };
    }
    return result;
  });

  return {
    ...sanitized,
    toolResults: sanitizedResults,
  };
}

function getMessagesCollection(userId: string, sessionId: string) {
  return `users/${userId}/chatSessions/${sessionId}/messages`;
}

/**
 * List all chat sessions for the current user
 */
export async function listChatSessions(
  ctx: OperationsContext,
  options: { limit?: number } = {}
): Promise<ChatSession[]> {
  const q = query(
    collection(ctx.db, `users/${ctx.userId}/chatSessions`),
    orderBy("updatedAt", "desc"),
    ...(options.limit ? [limit(options.limit)] : [])
  );

  const snapshot = await getDocs(q);
  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as ChatSession[];
}

/**
 * Get a single chat session by ID
 */
export async function getChatSession(
  ctx: OperationsContext,
  sessionId: string
): Promise<ChatSession | null> {
  const docRef = doc(ctx.db, `users/${ctx.userId}/chatSessions`, sessionId);
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) {
    return null;
  }

  return { id: snapshot.id, ...snapshot.data() } as ChatSession;
}

/**
 * Create a new chat session
 */
export async function createChatSession(
  ctx: OperationsContext,
  title?: string
): Promise<string> {
  const now = Timestamp.now();
  const newSession = {
    userId: ctx.userId,
    title: title || "New Chat",
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
  };

  const docRef = await addDoc(
    collection(ctx.db, `users/${ctx.userId}/chatSessions`),
    newSession
  );
  return docRef.id;
}

/**
 * Update a chat session
 */
export async function updateChatSession(
  ctx: OperationsContext,
  sessionId: string,
  data: Partial<Pick<ChatSession, "title" | "lastMessagePreview">>
): Promise<void> {
  const docRef = doc(ctx.db, `users/${ctx.userId}/chatSessions`, sessionId);
  await updateDoc(docRef, {
    ...data,
    updatedAt: Timestamp.now(),
  });
}

/**
 * Delete a chat session and all its messages
 */
export async function deleteChatSession(
  ctx: OperationsContext,
  sessionId: string
): Promise<void> {
  // First delete all messages in the session
  const messagesPath = getMessagesCollection(ctx.userId, sessionId);
  const messagesQuery = query(collection(ctx.db, messagesPath));
  const messagesSnapshot = await getDocs(messagesQuery);

  // Delete messages in parallel
  await Promise.all(
    messagesSnapshot.docs.map((doc) => deleteDoc(doc.ref))
  );

  // Then delete the session itself
  const sessionRef = doc(ctx.db, `users/${ctx.userId}/chatSessions`, sessionId);
  await deleteDoc(sessionRef);
}

/**
 * Get messages for a chat session
 */
export async function getChatMessages(
  ctx: OperationsContext,
  sessionId: string,
  options: { limit?: number; offset?: number } = {}
): Promise<ChatMessage[]> {
  const messagesPath = getMessagesCollection(ctx.userId, sessionId);

  // Try ordering by sequence first (for newer messages), fall back to createdAt
  // Note: sequence field may not exist on older messages
  const q = query(
    collection(ctx.db, messagesPath),
    orderBy("createdAt", "asc"),
    ...(options.limit ? [limit(options.limit)] : [])
  );

  const snapshot = await getDocs(q);
  const messages = snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as ChatMessage[];

  // Sort by sequence if available, otherwise keep createdAt order
  return messages.sort((a, b) => {
    // If both have sequence, use that
    if (a.sequence !== undefined && b.sequence !== undefined) {
      return a.sequence - b.sequence;
    }
    // Otherwise, keep original order (createdAt is already sorted by query)
    return 0;
  });
}

/**
 * Add a message to a chat session
 */
export async function addChatMessage(
  ctx: OperationsContext,
  sessionId: string,
  message: Omit<ChatMessage, "id" | "createdAt" | "sequence">
): Promise<string> {
  const messagesPath = getMessagesCollection(ctx.userId, sessionId);
  const now = Timestamp.now();

  // Update session with message count and preview first to get the new count
  const sessionRef = doc(ctx.db, `users/${ctx.userId}/chatSessions`, sessionId);
  const sessionSnap = await getDoc(sessionRef);

  let newCount = 1;
  if (sessionSnap.exists()) {
    const sessionData = sessionSnap.data();
    newCount = (sessionData.messageCount || 0) + 1;
  }

  // Sanitize large tool results to prevent Firestore rules memory overflow
  const sanitizedMessage = sanitizeMessageForStorage(message);

  const newMessage = {
    ...sanitizedMessage,
    createdAt: now,
    sequence: newCount, // Use message count as sequence for deterministic ordering
  };

  const docRef = await addDoc(collection(ctx.db, messagesPath), newMessage);

  // Update session
  if (sessionSnap.exists()) {
    // Generate title from first user message if this is the first message
    const updates: Record<string, unknown> = {
      messageCount: newCount,
      updatedAt: now,
    };

    if (message.content) {
      updates.lastMessagePreview = message.content.slice(0, 100);

      // Auto-generate title from first user message
      if (newCount === 1 && message.role === "user") {
        updates.title = message.content.slice(0, 50) + (message.content.length > 50 ? "..." : "");
      }
    }

    await updateDoc(sessionRef, updates);
  }

  return docRef.id;
}

/**
 * Update a message (e.g., to add tool results)
 */
export async function updateChatMessage(
  ctx: OperationsContext,
  sessionId: string,
  messageId: string,
  data: Partial<Pick<ChatMessage, "toolCalls" | "toolResults">>
): Promise<void> {
  const messagesPath = getMessagesCollection(ctx.userId, sessionId);
  const docRef = doc(ctx.db, messagesPath, messageId);
  await updateDoc(docRef, data);
}

/**
 * Upsert a message - create or update during streaming
 * Used for incremental message saving as assistant streams content
 */
export async function upsertChatMessage(
  ctx: OperationsContext,
  sessionId: string,
  messageId: string,
  message: Omit<ChatMessage, "id" | "createdAt">
): Promise<void> {
  const messagesPath = getMessagesCollection(ctx.userId, sessionId);
  const docRef = doc(ctx.db, messagesPath, messageId);
  const docSnap = await getDoc(docRef);

  // Sanitize large tool results to prevent Firestore rules memory overflow
  const sanitizedMessage = sanitizeMessageForStorage(message);

  if (docSnap.exists()) {
    // Update existing
    await updateDoc(docRef, {
      ...sanitizedMessage,
      updatedAt: Timestamp.now(),
    });
  } else {
    // Create new
    await addDoc(collection(ctx.db, messagesPath), {
      ...sanitizedMessage,
      createdAt: Timestamp.now(),
    });

    // Update session
    const sessionRef = doc(ctx.db, `users/${ctx.userId}/chatSessions`, sessionId);
    const sessionSnap = await getDoc(sessionRef);
    if (sessionSnap.exists()) {
      const sessionData = sessionSnap.data();
      const updates: Record<string, unknown> = {
        messageCount: (sessionData.messageCount || 0) + 1,
        updatedAt: Timestamp.now(),
      };

      if (message.content) {
        updates.lastMessagePreview = message.content.slice(0, 100);
      }

      await updateDoc(sessionRef, updates);
    }
  }
}

/**
 * Get or create an active session for the user
 */
export async function getOrCreateActiveSession(
  ctx: OperationsContext
): Promise<string> {
  // Try to find the most recent session
  const q = query(
    collection(ctx.db, `users/${ctx.userId}/chatSessions`),
    orderBy("updatedAt", "desc"),
    limit(1)
  );

  const snapshot = await getDocs(q);

  if (!snapshot.empty) {
    return snapshot.docs[0].id;
  }

  // No session exists, create a new one
  return createChatSession(ctx, "New Chat");
}

/**
 * Helper to serialize messages for the AI SDK format
 * Includes toolInvocations for proper restoration of chat history
 * Includes parts for chronological ordering when available
 */
export function serializeMessagesForSDK(
  messages: ChatMessage[]
): Array<{
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt?: Date;
  parts?: Array<{ type: "text"; text: string } | { type: "tool"; toolCallId: string; toolName: string }>;
  toolInvocations?: Array<{
    toolCallId: string;
    toolName: string;
    args: Record<string, unknown>;
    state: "result";
    result?: unknown;
  }>;
}> {
  return messages.map((m) => {
    const base = {
      id: m.id,
      role: m.role,
      content: m.content,
      createdAt: m.createdAt instanceof Date ? m.createdAt : m.createdAt?.toDate(),
    };

    // Include tool invocations if present
    if (m.toolCalls && m.toolCalls.length > 0) {
      const result: typeof base & {
        parts?: Array<{ type: "text"; text: string } | { type: "tool"; toolCallId: string; toolName: string }>;
        toolInvocations: Array<{
          toolCallId: string;
          toolName: string;
          args: Record<string, unknown>;
          state: "result";
          result?: unknown;
        }>;
      } = {
        ...base,
        toolInvocations: m.toolCalls.map((tc) => ({
          toolCallId: tc.id,
          toolName: tc.name,
          args: tc.args,
          state: "result" as const,
          result: tc.result ?? m.toolResults?.find((tr) => tr.toolCallId === tc.id)?.result,
        })),
      };

      // Include parts for chronological ordering if available
      // Handle both stored format (toolCallId/toolName) and TypeScript type format (toolCall object)
      if (m.parts && m.parts.length > 0) {
        result.parts = m.parts.map((p) => {
          if (p.type === "text") {
            return { type: "text" as const, text: p.text };
          }
          // Handle stored format (from Firestore)
          const storedPart = p as unknown as { type: "tool"; toolCallId?: string; toolName?: string; toolCall?: { id: string; name: string } };
          if (storedPart.toolCallId && storedPart.toolName) {
            return { type: "tool" as const, toolCallId: storedPart.toolCallId, toolName: storedPart.toolName };
          }
          // Handle TypeScript type format (toolCall object)
          if (storedPart.toolCall) {
            return { type: "tool" as const, toolCallId: storedPart.toolCall.id, toolName: storedPart.toolCall.name };
          }
          // Fallback - shouldn't happen
          return { type: "text" as const, text: "" };
        });
      }

      return result;
    }

    // Worker transcript format: parts contain full toolCall objects but no toolCalls array.
    // Pass parts through so the chat-provider normalization (hasWorkerParts) can render them
    // with proper GenUI tool result components instead of falling back to plain content text.
    if (m.parts && m.parts.length > 0) {
      const hasToolParts = m.parts.some((p) => {
        const part = p as unknown as { type: string; toolCall?: unknown };
        return part.type === "tool" && part.toolCall;
      });
      if (hasToolParts) {
        return { ...base, parts: m.parts as Array<{ type: "text"; text: string } | { type: "tool"; toolCallId: string; toolName: string }> };
      }
    }

    return base;
  });
}

/**
 * Helper to parse SDK messages to our format
 */
export function parseMessagesFromSDK(
  messages: Array<{
    id: string;
    role: string;
    content: string;
    toolInvocations?: Array<{
      toolCallId: string;
      toolName: string;
      args: Record<string, unknown>;
      state: string;
      result?: unknown;
    }>;
  }>
): Array<Omit<ChatMessage, "id" | "createdAt">> {
  return messages.map((m) => ({
    role: m.role as "user" | "assistant" | "system",
    content: m.content,
    toolCalls: m.toolInvocations?.map((ti) => ({
      id: ti.toolCallId,
      name: ti.toolName,
      args: ti.args,
      status: ti.state === "result" ? "executed" : "pending",
      requiresConfirmation: false,
    })) as ToolCall[] | undefined,
    toolResults: m.toolInvocations
      ?.filter((ti) => ti.state === "result")
      .map((ti) => ({
        toolCallId: ti.toolCallId,
        result: ti.result,
      })) as ToolResult[] | undefined,
  }));
}
