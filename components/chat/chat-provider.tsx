/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";

import { createContext, useContext, useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useChat as useVercelChat } from "@ai-sdk/react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { ChatContextValue, ChatTab, SidebarMode, UIControlActions, ToolCall, ChatSession, ModelProvider, ChatMessage } from "@/types/chat";
import { AutoActionNotification } from "@/types/notification";
import { requiresConfirmation } from "@/lib/chat/confirmation-config";
import { useNotifications } from "@/hooks/use-notifications";
import { useChatPersistence } from "@/hooks/use-chat-persistence";
import { useChatSessions } from "@/hooks/use-chat-sessions";
import { useWorker } from "@/hooks/use-worker";
import { useAuth } from "@/components/auth";
import { db } from "@/lib/firebase/config";
import { serializeMessagesForSDK } from "@/lib/operations";
import { useChatUrlCommand } from "@/hooks/use-chat-url-state";
import { readPersistedChatState, persistSidebarOpen, persistActiveTab } from "@/lib/chat/chat-local-state";

const ChatContext = createContext<ChatContextValue | null>(null);

// Sidebar width constants
const SIDEBAR_WIDTH_KEY = "chatSidebarWidth";
const DEFAULT_SIDEBAR_WIDTH = 320; // w-80 = 20rem = 320px
const MIN_SIDEBAR_WIDTH = 280;
const MAX_SIDEBAR_WIDTH = 600;
const CHAT_DEBUG_ENABLED = process.env.NODE_ENV !== "production";

type ChatViewMode = "closed" | "notifications" | "history" | "draft" | "loadingSession" | "session";

function resolveChatViewMode(args: {
  isSidebarOpen: boolean;
  activeTab: ChatTab;
  isSessionLoading: boolean;
  hasSessionId: boolean;
  messageCount: number;
}): ChatViewMode {
  if (!args.isSidebarOpen) return "closed";
  if (args.activeTab === "notifications") return "notifications";
  if (args.activeTab === "history") return "history";
  if (args.isSessionLoading && args.hasSessionId) return "loadingSession";
  if (args.messageCount > 0 && args.hasSessionId) return "session";
  return "draft";
}

export function useChat() {
  const context = useContext(ChatContext);
  if (!context) {
    throw new Error("useChat must be used within a ChatProvider");
  }
  return context;
}

interface ChatProviderProps {
  children: React.ReactNode;
}

export function ChatProvider({ children }: ChatProviderProps) {
  const router = useRouter();
  const { initialCommand, consumeParam } = useChatUrlCommand();
  const { user } = useAuth();

  // Worker hook for wand button actions
  const {
    triggerReceiptSearch,
    triggerPartnerSearch,
    triggerFilePartnerSearch,
    triggerFileTransactionSearch,
  } = useWorker();

  // Resolve initial state: URL command overrides localStorage fallback.
  const initialState = useRef(
    initialCommand.hasChatParam
      ? {
          isSidebarOpen: initialCommand.isSidebarOpen,
          activeTab: "chat" as ChatTab,
          sessionId: initialCommand.sessionId,
        }
      : (() => {
          const persisted = readPersistedChatState();
          return {
            isSidebarOpen: persisted.isSidebarOpen,
            activeTab: persisted.activeTab,
            sessionId: null as string | null,
          };
        })()
  ).current;

  const [isSidebarOpen, setIsSidebarOpen] = useState(initialState.isSidebarOpen);
  const [sidebarWidth, setSidebarWidth] = useState(DEFAULT_SIDEBAR_WIDTH);
  const [pendingConfirmations, setPendingConfirmations] = useState<ToolCall[]>([]);
  const [activeTab, setActiveTabState] = useState<ChatTab>(initialState.activeTab);
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>("chat");
  const [chatViewMode, setChatViewMode] = useState<ChatViewMode>(
    initialState.isSidebarOpen ? "draft" : "closed"
  );
  // Default to gemini (cheaper), fall back to anthropic if needed
  const [modelProvider, setModelProvider] = useState<ModelProvider>("gemini");

  // Track entity IDs with active wand searches (workers)
  const [activeWandTargets, setActiveWandTargets] = useState<Set<string>>(new Set());
  // Track when each wand target was triggered to avoid opening stale sessions.
  const wandTriggeredAtRef = useRef<Map<string, number>>(new Map());
  // Track already auto-opened session keys (entityId:sessionId) to avoid repeated loads.
  const openedWandSessionKeysRef = useRef<Set<string>>(new Set());

  const currentSessionIdRef = useRef<string | null>(null);
  const loadSessionRequestIdRef = useRef(0);

  // Notifications hook
  const {
    notifications,
    unreadCount: unreadNotificationCount,
    markRead: markNotificationRead,
    markAllRead: markAllNotificationsRead,
  } = useNotifications();

  // Chat persistence hook
  const {
    currentSessionId,
    isLoading: isSessionLoading,
    saveMessage,
    switchSession,
  } = useChatPersistence();

  useEffect(() => {
    currentSessionIdRef.current = currentSessionId;
  }, [currentSessionId]);

  // Chat sessions hook (for history)
  const {
    sessions,
    isLoading: isSessionsLoading,
    getSessionMessages,
  } = useChatSessions();

  // Keep user in a ref so we can always access the current value in callbacks
  const userRef = useRef(user);
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  const debugChat = useCallback((event: string, payload: Record<string, unknown>) => {
    if (!CHAT_DEBUG_ENABLED) return;
    console.debug(`[ChatState] ${event}`, payload);
  }, []);

  // Helper to get auth headers - must be called before each request
  const getAuthHeaders = useCallback(async (): Promise<Record<string, string>> => {
    const currentUser = userRef.current;
    if (!currentUser) {
      console.warn("[Chat] No user available for auth headers");
      return {};
    }
    try {
      const token = await currentUser.getIdToken();
      return { Authorization: `Bearer ${token}` };
    } catch (e) {
      console.error("[Chat] Failed to get auth token:", e);
      return {};
    }
  }, []);

  // Use Vercel AI SDK's useChat hook
  // Note: We don't rely on hook-level headers - we pass them explicitly per-request
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chatHook = (useVercelChat as any)({
    api: "/api/chat",
    onToolCall: ({ toolCall }: { toolCall: any }) => {
      // Check if this tool requires confirmation
      if (requiresConfirmation(toolCall.toolName)) {
        setPendingConfirmations((prev) => [
          ...prev,
          {
            id: toolCall.toolCallId,
            name: toolCall.toolName,
            args: toolCall.args as Record<string, unknown>,
            status: "pending",
            requiresConfirmation: true,
          },
        ]);
      }
    },
    onFinish: (message: any) => {
      // Handle UI actions from tool results
      if (message.toolInvocations) {
        for (const invocation of message.toolInvocations) {
          if (invocation.state === "result" && invocation.result) {
            const result = invocation.result as { action?: string; [key: string]: unknown };
            if (result.action) {
              handleUIAction(result as { action: string; [key: string]: unknown });
            }
          }
        }
      }
    },
  });

  const { messages, status, setMessages, sendMessage: sdkSendMessage } = chatHook;
  const isLoading = status === "streaming" || status === "submitted";

  // Track last saved message count to save new assistant messages
  const lastSavedMessageCount = useRef(0);

  const setActiveTab = useCallback((tab: ChatTab) => {
    debugChat("tab_change", { from: activeTab, to: tab, modeBefore: chatViewMode });
    setActiveTabState(tab);

    // Leaving chat should reset visible conversation context.
    if (tab !== "chat") {
      setMessages([]);
      setPendingConfirmations([]);
      lastSavedMessageCount.current = 0;
    }
  }, [activeTab, chatViewMode, setMessages, debugChat]);

  // Save assistant messages when they complete
  useEffect(() => {
    if (isLoading || messages.length <= lastSavedMessageCount.current) return;

    // Save any new assistant messages
    const newMessages = messages.slice(lastSavedMessageCount.current);
    for (const msg of newMessages) {
      if (msg.role === "assistant") {
        // Extract text content from parts or content
        let textContent = "";
        const toolInvocations: Array<{
          toolCallId: string;
          toolName: string;
          args: Record<string, unknown>;
          state: string;
          result?: unknown;
        }> = [];

        if ((msg as any).parts) {
          for (const p of (msg as any).parts) {
            if (p.type === "text" && p.text) {
              textContent += p.text;
            } else if (typeof p.type === "string" && (p.type.startsWith("tool-") || p.type === "dynamic-tool")) {
              // Extract tool invocation data
              const toolName = p.toolName || (p.type.startsWith("tool-") ? p.type.replace("tool-", "") : null);
              if (toolName && p.toolCallId) {
                // Check if we already have this tool call
                const existing = toolInvocations.find((t) => t.toolCallId === p.toolCallId);
                if (existing) {
                  // Update existing
                  if (p.input) existing.args = p.input;
                  if (p.output !== undefined) existing.result = typeof p.output === "string" ? JSON.parse(p.output) : p.output;
                  if (p.state) existing.state = p.state;
                } else {
                  toolInvocations.push({
                    toolCallId: p.toolCallId,
                    toolName,
                    args: p.input || {},
                    state: p.state || "result",
                    result: p.output !== undefined ? (typeof p.output === "string" ? JSON.parse(p.output) : p.output) : undefined,
                  });
                }
              }
            }
          }
        } else if ((msg as { content?: string }).content) {
          textContent = (msg as { content: string }).content;
        }

        // Build parts array in chronological order for proper history rendering
        const orderedParts: Array<{ type: "text"; text: string } | { type: "tool"; toolCallId: string; toolName: string }> = [];
        if ((msg as any).parts) {
          for (const p of (msg as any).parts) {
            if (p.type === "text" && p.text) {
              orderedParts.push({ type: "text", text: p.text });
            } else if (typeof p.type === "string" && (p.type.startsWith("tool-") || p.type === "dynamic-tool")) {
              const toolName = p.toolName || (p.type.startsWith("tool-") ? p.type.replace("tool-", "") : null);
              // Only add unique tool calls (by toolCallId)
              if (toolName && p.toolCallId && !orderedParts.some(part => part.type === "tool" && part.toolCallId === p.toolCallId)) {
                orderedParts.push({ type: "tool", toolCallId: p.toolCallId, toolName });
              }
            }
          }
        }

        // Save message with tool invocations (only include fields with values - Firestore rejects undefined)
        const messageToSave: {
          role: "assistant";
          content: string;
          parts?: Array<{ type: "text"; text: string } | { type: "tool"; toolCallId: string; toolName: string }>;
          toolCalls?: ToolCall[];
          toolResults?: { toolCallId: string; result: unknown }[];
        } = {
          role: "assistant",
          content: textContent,
        };

        // Include parts for chronological ordering in history
        if (orderedParts.length > 0) {
          messageToSave.parts = orderedParts;
        }

        if (toolInvocations.length > 0) {
          messageToSave.toolCalls = toolInvocations.map((t) => ({
            id: t.toolCallId,
            name: t.toolName,
            args: t.args,
            result: t.result,
            status: "executed" as const,
            requiresConfirmation: false,
          }));

          const resultsWithData = toolInvocations.filter((t) => t.result !== undefined);
          if (resultsWithData.length > 0) {
            messageToSave.toolResults = resultsWithData.map((t) => ({
              toolCallId: t.toolCallId,
              result: t.result,
            }));
          }
        }

        saveMessage(messageToSave).catch((err) => console.error("Failed to save assistant message:", err));
      }
    }

    lastSavedMessageCount.current = messages.length;
  }, [messages, isLoading, saveMessage]);

  // UI Control Actions
  const uiActions: UIControlActions = useMemo(
    () => ({
      navigateTo: (path: string) => {
        router.push(path);
      },

      openTransactionSheet: (transactionId: string) => {
        window.dispatchEvent(
          new CustomEvent("chat:openTransaction", {
            detail: { transactionId },
          })
        );
      },

      closeTransactionSheet: () => {
        window.dispatchEvent(new CustomEvent("chat:closeTransaction"));
      },

      scrollToTransaction: (transactionId: string) => {
        window.dispatchEvent(
          new CustomEvent("chat:scrollToTransaction", {
            detail: { transactionId },
          })
        );
      },

      highlightTransaction: (transactionId: string) => {
        window.dispatchEvent(
          new CustomEvent("chat:highlightTransaction", {
            detail: { transactionId },
          })
        );
      },

      showNotification: (message: string, type: "success" | "error" | "info") => {
        window.dispatchEvent(
          new CustomEvent("chat:notification", {
            detail: { message, type },
          })
        );
      },

      openFile: (fileId: string) => {
        window.dispatchEvent(
          new CustomEvent("chat:openFile", {
            detail: { fileId },
          })
        );
      },
    }),
    [router]
  );

  // Handle UI actions from tool results
  const handleUIAction = useCallback(
    (result: { action: string; [key: string]: unknown }) => {
      switch (result.action) {
        case "navigate":
          uiActions.navigateTo(result.path as string);
          break;
        case "openSheet":
          uiActions.openTransactionSheet(result.transactionId as string);
          break;
        case "scrollTo":
          uiActions.scrollToTransaction(result.transactionId as string);
          break;
      }
    },
    [uiActions]
  );

  // Send message using the SDK's sendMessage with explicit auth headers
  const sendMessage = useCallback(
    async (content: string) => {
      // Save user message to Firestore
      saveMessage({
        role: "user",
        content,
      }).catch((err) => console.error("Failed to save user message:", err));

      // Get fresh auth headers for this request
      const headers = await getAuthHeaders();
      await sdkSendMessage(
        { role: "user", content },
        { headers, body: { modelProvider } }
      );
    },
    [sdkSendMessage, saveMessage, getAuthHeaders, modelProvider]
  );

  // Approve tool call (for confirmation flow)
  const approveToolCall = useCallback(async (toolCallId: string) => {
    setPendingConfirmations((prev) =>
      prev.map((tc) => (tc.id === toolCallId ? { ...tc, status: "approved" } : tc))
    );

    // The tool will be executed by the AI SDK
    // Remove from pending after a short delay
    setTimeout(() => {
      setPendingConfirmations((prev) => prev.filter((tc) => tc.id !== toolCallId));
    }, 1000);
  }, []);

  // Reject tool call
  const rejectToolCall = useCallback((toolCallId: string) => {
    setPendingConfirmations((prev) =>
      prev.map((tc) => (tc.id === toolCallId ? { ...tc, status: "rejected" } : tc))
    );

    // Remove from pending
    setTimeout(() => {
      setPendingConfirmations((prev) => prev.filter((tc) => tc.id !== toolCallId));
    }, 500);
  }, []);

  // Start new session (clear messages)
  const startNewSession = useCallback(async () => {
    loadSessionRequestIdRef.current += 1; // Cancel in-flight session loads.
    debugChat("start_new_chat_draft", { previousSessionId: currentSessionIdRef.current });

    // Reset to a draft conversation; actual session is created lazily on first message.
    await switchSession(null);
    setMessages([]);
    setPendingConfirmations([]);
    setActiveTab("chat");
    setSidebarMode("chat");
    setChatViewMode("draft");
    lastSavedMessageCount.current = 0;
  }, [switchSession, setMessages, setActiveTab, debugChat]);

  // Load session - actually load messages from Firestore
  const loadSession = useCallback(async (sessionId: string) => {
    const requestId = ++loadSessionRequestIdRef.current;
    debugChat("load_session_start", { sessionId, requestId });
    if (!isSidebarOpen) {
      setIsSidebarOpen(true);
    }
    setSidebarMode("chat");
    setActiveTabState("chat");
    setChatViewMode("loadingSession");
    setMessages([]);
    setPendingConfirmations([]);

    try {
      // Bind the target session immediately so UI can track worker progress even before messages load.
      await switchSession(sessionId);
      if (requestId !== loadSessionRequestIdRef.current) {
        debugChat("load_session_stale_ignored_after_early_switch", { sessionId, requestId, latestRequestId: loadSessionRequestIdRef.current });
        return;
      }

      // Get messages for the session (already includes toolInvocations from serializeMessagesForSDK)
      const messages = await getSessionMessages(sessionId);

      // Messages from serializeMessagesForSDK already have the correct format including toolInvocations
      // Just ensure proper typing for the SDK
      const sdkMessages = messages.map((m: any) => ({
        id: m.id,
        role: m.role as "user" | "assistant" | "system",
        content: m.content || "",
        createdAt: m.createdAt,
        // Include parts if present (for chronological order in useMemo normalization)
        ...(m.parts && m.parts.length > 0 ? { parts: m.parts } : {}),
        // Include toolInvocations if present (for restoring tool call UI)
        ...(m.toolInvocations && m.toolInvocations.length > 0 ? { toolInvocations: m.toolInvocations } : {}),
      }));

      // If another request started while this one was in flight, ignore stale result.
      if (requestId !== loadSessionRequestIdRef.current) {
        debugChat("load_session_stale_ignored", { sessionId, requestId, latestRequestId: loadSessionRequestIdRef.current });
        return;
      }

      // Prime counter before rendering loaded messages to avoid re-saving history as new output.
      lastSavedMessageCount.current = sdkMessages.length;

      // Update the chat state
      setMessages(sdkMessages);
      setPendingConfirmations([]);
      setChatViewMode("session");
      debugChat("load_session_success", { sessionId, requestId, messageCount: sdkMessages.length });
    } catch (error) {
      console.error("Failed to load session:", error);
      debugChat("load_session_error", { sessionId, requestId, error: String(error) });
    }
  }, [getSessionMessages, setMessages, switchSession, debugChat, isSidebarOpen]);

  // Live-sync worker sessions while they are running so "View in chat" streams progress.
  useEffect(() => {
    if (!user || !currentSessionId) return;

    const activeSession = sessions.find((s) => s.id === currentSessionId) as (ChatSession & { isWorkerSession?: boolean }) | undefined;
    if (!activeSession?.isWorkerSession) return;

    const messagesQuery = query(
      collection(db, `users/${user.uid}/chatSessions/${currentSessionId}/messages`),
      orderBy("createdAt", "asc")
    );

    const unsubscribe = onSnapshot(
      messagesQuery,
      (snapshot) => {
        const storedMessages = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as ChatMessage[];
        const sortedMessages = [...storedMessages].sort((a, b) => {
          if (a.sequence !== undefined && b.sequence !== undefined) {
            return a.sequence - b.sequence;
          }
          return 0;
        });
        const sdkMessages = serializeMessagesForSDK(sortedMessages).map((m: any) => ({
          id: m.id,
          role: m.role as "user" | "assistant" | "system",
          content: m.content || "",
          createdAt: m.createdAt,
          ...(m.parts && m.parts.length > 0 ? { parts: m.parts } : {}),
          ...(m.toolInvocations && m.toolInvocations.length > 0 ? { toolInvocations: m.toolInvocations } : {}),
        }));

        // Keep persistence cursor in sync to avoid re-saving already-stored worker messages.
        lastSavedMessageCount.current = sdkMessages.length;
        setMessages(sdkMessages);
      },
      (error) => {
        console.error("Failed to live-sync worker session:", error);
      }
    );

    return () => unsubscribe();
  }, [user, currentSessionId, sessions, setMessages]);

  // Toggle sidebar
  const toggleSidebar = useCallback(() => {
    setIsSidebarOpen((prev) => {
      const next = !prev;
      debugChat("toggle_sidebar", { fromOpen: prev, toOpen: next });
      if (!next) {
        setChatViewMode("closed");
      }
      return next;
    });
  }, [debugChat]);

  // Helper: trigger a wand search via worker API
  const triggerWandSearch = useCallback(
    async (
      entityId: string,
      triggerFn: () => Promise<{ sessionId?: string; status?: string }>
    ) => {
      // Add entity to active targets
      setActiveWandTargets((prev) => new Set(prev).add(entityId));
      wandTriggeredAtRef.current.set(entityId, Date.now());

      // Open sidebar directly on chat tab for processing view and clear prior chat context.
      setSidebarMode("chat");
      setActiveTab("chat");
      if (!isSidebarOpen) {
        setIsSidebarOpen(true);
      }
      loadSessionRequestIdRef.current += 1; // Cancel any in-flight manual session load.
      await switchSession(null);
      setMessages([]);
      setPendingConfirmations([]);
      lastSavedMessageCount.current = 0;
      setChatViewMode("loadingSession");

      try {
        const result = await triggerFn();
        const sessionId = result?.sessionId;

        // If API already knows the target session, load it immediately.
        if (sessionId) {
          const sessionKey = `${entityId}:${sessionId}`;
          if (!openedWandSessionKeysRef.current.has(sessionKey)) {
            openedWandSessionKeysRef.current.add(sessionKey);
            void loadSession(sessionId);
          }
        }
      } catch (err) {
        console.error("Worker trigger failed:", err);
        wandTriggeredAtRef.current.delete(entityId);
        for (const key of Array.from(openedWandSessionKeysRef.current)) {
          if (key.startsWith(`${entityId}:`)) {
            openedWandSessionKeysRef.current.delete(key);
          }
        }
        // Remove from active targets on trigger failure (worker never started)
        setActiveWandTargets((prev) => {
          const next = new Set(prev);
          next.delete(entityId);
          return next;
        });
      }
      // On success, worker creates its own notification; cleanup happens via notification listener below
    },
    [isSidebarOpen, loadSession, setActiveTab, switchSession, setMessages]
  );

  // Wand: receipt search for transaction
  const startReceiptSearch = useCallback(
    (transactionId: string) => {
      triggerWandSearch(transactionId, () => triggerReceiptSearch(transactionId));
    },
    [triggerWandSearch, triggerReceiptSearch]
  );

  // Wand: partner search for transaction
  const startPartnerSearch = useCallback(
    (transactionId: string) => {
      triggerWandSearch(transactionId, () => triggerPartnerSearch(transactionId));
    },
    [triggerWandSearch, triggerPartnerSearch]
  );

  // Wand: partner search for file
  const startFilePartnerSearch = useCallback(
    (fileId: string) => {
      triggerWandSearch(fileId, () => triggerFilePartnerSearch(fileId));
    },
    [triggerWandSearch, triggerFilePartnerSearch]
  );

  // Wand: transaction search for file
  const startFileTransactionSearch = useCallback(
    (
      fileId: string,
      fileInfo?: {
        fileName?: string;
        amount?: number;
        currency?: string;
        date?: string;
        partner?: string;
      }
    ) => {
      triggerWandSearch(fileId, () => triggerFileTransactionSearch(fileId, fileInfo));
    },
    [triggerWandSearch, triggerFileTransactionSearch]
  );

  // Auto-open the exact worker chat session for wand-triggered runs once notification context has it.
  useEffect(() => {
    if (activeWandTargets.size === 0) return;

    for (const notification of notifications) {
      if (notification.type !== "worker_activity") continue;
      const ctx = notification.context;
      const entityId = ctx.transactionId || ctx.fileId;
      const sessionId = ctx.sessionId;
      if (!entityId || !sessionId) continue;
      if (!activeWandTargets.has(entityId)) continue;

      // Ignore stale notifications from older runs of the same entity.
      const triggeredAt = wandTriggeredAtRef.current.get(entityId);
      const createdAt = notification.createdAt?.toDate?.().getTime();
      if (triggeredAt && createdAt && createdAt < triggeredAt - 5000) continue;

      const sessionKey = `${entityId}:${sessionId}`;
      if (openedWandSessionKeysRef.current.has(sessionKey)) continue;
      openedWandSessionKeysRef.current.add(sessionKey);

      setSidebarMode("chat");
      setActiveTab("chat");
      if (!isSidebarOpen) {
        setIsSidebarOpen(true);
      }
      void loadSession(sessionId);
    }
  }, [notifications, activeWandTargets, loadSession, isSidebarOpen]);

  // Clean up activeWandTargets when worker notifications complete
  useEffect(() => {
    if (activeWandTargets.size === 0) return;

    // Check notifications for completed workers matching our active targets
    for (const notification of notifications) {
      if (notification.type !== "worker_activity") continue;
      const ctx = notification.context;
      if (ctx.workerStatus !== "completed" && ctx.workerStatus !== "failed") continue;

      const entityId = ctx.transactionId || ctx.fileId;
      if (entityId && activeWandTargets.has(entityId)) {
        // Ignore stale completed notifications from older runs of the same entity.
        const triggeredAt = wandTriggeredAtRef.current.get(entityId);
        const createdAt = notification.createdAt?.toDate?.().getTime();
        if (triggeredAt && createdAt && createdAt < triggeredAt - 5000) continue;

        wandTriggeredAtRef.current.delete(entityId);
        for (const key of Array.from(openedWandSessionKeysRef.current)) {
          if (key.startsWith(`${entityId}:`)) {
            openedWandSessionKeysRef.current.delete(key);
          }
        }
        setActiveWandTargets((prev) => {
          const next = new Set(prev);
          next.delete(entityId);
          return next;
        });
      }
    }
  }, [notifications, activeWandTargets]);

  // Start conversation from a notification
  const startConversationFromNotification = useCallback(
    (notification: AutoActionNotification) => {
      // Switch to chat tab
      setActiveTab("chat");

      // Mark notification as read
      markNotificationRead(notification.id);

      // Generate a context message based on notification type
      let contextMessage = "";
      switch (notification.type) {
        case "import_complete":
          contextMessage = `I just imported ${notification.context.transactionCount || "some"} transactions from ${notification.context.sourceName || "a bank account"}. Can you help me review and categorize them?`;
          break;
        case "partner_matching":
          if (notification.context.autoMatchedCount) {
            contextMessage = `You just matched ${notification.context.autoMatchedCount} transactions automatically. Can you show me what was matched and if there are any suggestions I should review?`;
          } else {
            contextMessage = `You found partner suggestions for ${notification.context.suggestionsCount || "some"} transactions. Can you show me these suggestions?`;
          }
          break;
        case "pattern_learned":
          contextMessage = `You learned new patterns for ${notification.context.partnerName || "a partner"} and matched ${notification.context.transactionsMatched || "some"} transactions. Can you show me what was matched?`;
          break;
        default:
          contextMessage = "Can you help me with my recent transactions?";
      }

      // Clear previous messages and send the context message
      setMessages([]);
      // Reset saved message counter for new conversation
      lastSavedMessageCount.current = 0;
      // Use setTimeout to ensure state is cleared, then use wrapped sendMessage (saves to Firestore)
      setTimeout(() => {
        sendMessage(contextMessage);
      }, 100);
    },
    [markNotificationRead, setMessages, sendMessage]
  );

  useEffect(() => {
    const nextMode = resolveChatViewMode({
      isSidebarOpen,
      activeTab,
      isSessionLoading,
      hasSessionId: Boolean(currentSessionId),
      messageCount: messages.length,
    });

    if (nextMode !== chatViewMode) {
      debugChat("mode_transition", {
        from: chatViewMode,
        to: nextMode,
        isSidebarOpen,
        activeTab,
        isSessionLoading,
        hasSessionId: Boolean(currentSessionId),
        messageCount: messages.length,
      });
      setChatViewMode(nextMode);
    }
  }, [
    isSidebarOpen,
    activeTab,
    isSessionLoading,
    currentSessionId,
    messages.length,
    chatViewMode,
    debugChat,
  ]);

  // Load sidebar width from localStorage (width still uses localStorage, not URL)
  useEffect(() => {
    const savedWidth = localStorage.getItem(SIDEBAR_WIDTH_KEY);
    if (savedWidth) {
      const parsed = parseInt(savedWidth, 10);
      if (!isNaN(parsed) && parsed >= MIN_SIDEBAR_WIDTH && parsed <= MAX_SIDEBAR_WIDTH) {
        setSidebarWidth(parsed);
      }
    }
  }, []);

  // One-shot: consume ?chat= URL param and load session if specified.
  const mountConsumedRef = useRef(false);
  useEffect(() => {
    if (mountConsumedRef.current) return;
    mountConsumedRef.current = true;

    if (!initialCommand.hasChatParam) return;
    consumeParam();

    if (initialCommand.sessionId) {
      debugChat("url_command_load_session", { sessionId: initialCommand.sessionId });
      void loadSession(initialCommand.sessionId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist sidebar open/closed to localStorage (skip first render — already from localStorage/URL).
  const isFirstSidebarRender = useRef(true);
  useEffect(() => {
    if (isFirstSidebarRender.current) {
      isFirstSidebarRender.current = false;
      return;
    }
    persistSidebarOpen(isSidebarOpen);
  }, [isSidebarOpen]);

  // Persist active tab to localStorage (skip first render).
  const isFirstTabRender = useRef(true);
  useEffect(() => {
    if (isFirstTabRender.current) {
      isFirstTabRender.current = false;
      return;
    }
    persistActiveTab(activeTab);
  }, [activeTab]);

  // Handler for setting sidebar width (with persistence)
  const handleSetSidebarWidth = useCallback((width: number) => {
    const clampedWidth = Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, width));
    setSidebarWidth(clampedWidth);
    localStorage.setItem(SIDEBAR_WIDTH_KEY, clampedWidth.toString());
  }, []);

  const value: ChatContextValue = useMemo(
    () => ({
      messages: messages.map((m: any) => {
        // AI SDK v6 uses 'parts' array - preserve order for chronological rendering
        const orderedParts: Array<{ type: "text"; text: string } | { type: "tool"; toolCall: NonNullable<ChatContextValue["messages"][0]["toolCalls"]>[0] }> = [];
        let fullTextContent = "";

        // Handle messages loaded from Firestore
        // Check if we have stored parts with chronological order
        const storedParts = m.parts as Array<{ type: string; text?: string; toolCallId?: string; toolName?: string; toolCall?: ToolCall }> | undefined;
        const hasStoredParts = storedParts && storedParts.length > 0 && storedParts.some((p) => p.type === "tool" && p.toolCallId);

        // Check for worker-saved format: parts with full toolCall objects (from worker-graph transcript)
        const hasWorkerParts = storedParts && storedParts.length > 0 && storedParts.some((p) => p.type === "tool" && (p as { toolCall?: unknown }).toolCall);

        if (hasWorkerParts) {
          // Worker transcript format: parts already have full toolCall objects
          for (const p of storedParts) {
            if (p.type === "text" && p.text) {
              fullTextContent += p.text;
              orderedParts.push({ type: "text", text: p.text });
            } else if (p.type === "tool" && (p as { toolCall?: ToolCall }).toolCall) {
              const toolCall = (p as { toolCall: ToolCall }).toolCall;
              orderedParts.push({
                type: "tool",
                toolCall: {
                  id: toolCall.id,
                  name: toolCall.name,
                  args: toolCall.args || {},
                  result: toolCall.result,
                  status: toolCall.status || "executed",
                  requiresConfirmation: toolCall.requiresConfirmation ?? false,
                },
              });
            }
          }
        } else if (hasStoredParts && m.toolInvocations && m.toolInvocations.length > 0) {
          // Use stored parts for chronological order, with tool data from toolInvocations
          for (const p of storedParts) {
            if (p.type === "text" && p.text) {
              fullTextContent += p.text;
              orderedParts.push({ type: "text", text: p.text });
            } else if (p.type === "tool" && p.toolCallId) {
              // Find tool data from toolInvocations
              const ti = m.toolInvocations.find((t: { toolCallId: string }) => t.toolCallId === p.toolCallId);
              if (ti) {
                orderedParts.push({
                  type: "tool",
                  toolCall: {
                    id: ti.toolCallId,
                    name: ti.toolName,
                    args: ti.args || {},
                    result: ti.result,
                    status: ti.state === "result" || ti.result !== undefined ? "executed" : "pending",
                    requiresConfirmation: requiresConfirmation(ti.toolName),
                  },
                });
              }
            }
          }
        } else if (m.toolInvocations && m.toolInvocations.length > 0) {
          // Legacy: no stored parts, reconstruct (text first, then all tools)
          if (m.content) {
            fullTextContent = m.content;
            orderedParts.push({ type: "text", text: m.content });
          }
          // Then add tool invocations
          for (const ti of m.toolInvocations) {
            orderedParts.push({
              type: "tool",
              toolCall: {
                id: ti.toolCallId,
                name: ti.toolName,
                args: ti.args || {},
                result: ti.result,
                status: ti.state === "result" || ti.result !== undefined ? "executed" : "pending",
                requiresConfirmation: requiresConfirmation(ti.toolName),
              },
            });
          }
        } else if (m.parts) {
          // Handle live streaming messages (have parts array)
          // Track tool calls by ID to merge chunks, and their index in orderedParts for in-place updates
          const toolCallsById = new Map<string, {
            data: {
              id: string;
              name: string;
              args: Record<string, unknown>;
              result?: unknown;
              state: string;
            };
            partIndex: number; // Index in orderedParts where this tool is rendered
          }>();

          // Helper to parse JSON output
          const parseOutput = (output: unknown) => {
            if (typeof output === "string") {
              try {
                return JSON.parse(output);
              } catch {
                return output;
              }
            }
            return output;
          };

          // Helper to create tool part for orderedParts
          const createToolPart = (toolCall: { id: string; name: string; args: Record<string, unknown>; result?: unknown; state: string }) => ({
            type: "tool" as const,
            toolCall: {
              id: toolCall.id,
              name: toolCall.name,
              args: toolCall.args,
              result: toolCall.result,
              status:
                toolCall.state === "output-available" || toolCall.result !== undefined
                  ? ("executed" as const)
                  : toolCall.state === "input-available" || toolCall.state === "input-streaming"
                  ? ("pending" as const)
                  : pendingConfirmations.find((pc) => pc.id === toolCall.id)?.status || ("pending" as const),
              requiresConfirmation: requiresConfirmation(toolCall.name),
            },
          });

          for (const p of m.parts) {
            if (p.type === "text" && (p as { text?: string }).text) {
              const text = (p as { text: string }).text;
              fullTextContent += text;
              orderedParts.push({ type: "text", text });
            } else if (typeof p.type === "string" && (p.type.startsWith("tool-") || p.type === "dynamic-tool")) {
              // Handle tool parts - could be chunk types or accumulated types
              const toolPart = p as {
                type: string;
                toolCallId: string;
                toolName?: string;
                input?: Record<string, unknown>;
                output?: unknown;
                state?: string;
                dynamic?: boolean;
              };

              // Determine tool name
              let toolName: string | null = null;
              if (toolPart.toolName) {
                toolName = toolPart.toolName;
              } else if (p.type.startsWith("tool-") && !["tool-input-start", "tool-input-delta", "tool-output-available", "tool-result"].includes(p.type)) {
                toolName = p.type.replace("tool-", "");
              }

              // For chunk types without toolName, try to find if we have a pending tool with this ID
              // This helps preserve tool calls that arrive in chunks
              const toolCallId = toolPart.toolCallId;
              const existing = toolCallsById.get(toolCallId);
              const parsedOutput = parseOutput(toolPart.output);

              if (existing) {
                // Update existing tool call data
                if (toolPart.input) existing.data.args = toolPart.input;
                if (parsedOutput !== undefined) existing.data.result = parsedOutput;
                if (toolPart.state) existing.data.state = toolPart.state;
                // Update the part in orderedParts in-place
                orderedParts[existing.partIndex] = createToolPart(existing.data);
              } else if (toolName) {
                // Create new tool call and add to orderedParts at current position
                const toolData = {
                  id: toolCallId,
                  name: toolName,
                  args: toolPart.input || {},
                  result: parsedOutput,
                  state: toolPart.state || "pending",
                };
                const partIndex = orderedParts.length;
                orderedParts.push(createToolPart(toolData));
                toolCallsById.set(toolCallId, { data: toolData, partIndex });
              }
              // Note: If no toolName and not tracked, skip silently (chunk without header)
            }
          }
        }

        // Fallback for legacy content string (no parts, no toolInvocations)
        if (!fullTextContent && (m as unknown as { content?: string }).content) {
          fullTextContent = (m as unknown as { content: string }).content;
          if (orderedParts.length === 0 || orderedParts[0].type !== "text") {
            orderedParts.unshift({ type: "text", text: fullTextContent });
          }
        }

        return {
          id: m.id,
          role: m.role as "user" | "assistant" | "system",
          content: fullTextContent,
          createdAt: m.createdAt instanceof Date ? m.createdAt : new Date(),
          parts: orderedParts,
          toolCalls: orderedParts
            .filter((p): p is { type: "tool"; toolCall: NonNullable<ChatContextValue["messages"][0]["toolCalls"]>[0] } => p.type === "tool")
            .map((p) => p.toolCall),
        };
      }) as ChatContextValue["messages"],
      isLoading,
      isStreaming: isLoading,
      currentSession: sessions.find((s) => s.id === currentSessionId) || null,
      sessions,
      currentSessionId,
      pendingConfirmations,
      sendMessage,
      approveToolCall,
      rejectToolCall,
      startNewSession,
      loadSession,
      uiActions,
      isSidebarOpen,
      toggleSidebar,
      sidebarWidth,
      setSidebarWidth: handleSetSidebarWidth,
      // Tabs & Notifications
      activeTab,
      setActiveTab,
      notifications,
      unreadNotificationCount,
      markNotificationRead,
      markAllNotificationsRead,
      startConversationFromNotification,
      // Agentic search (via workers)
      startReceiptSearch,
      startPartnerSearch,
      startFilePartnerSearch,
      startFileTransactionSearch,
      activeWandTargets,
      // Sidebar mode
      sidebarMode,
      setSidebarMode,
      // Model selection
      modelProvider,
      setModelProvider,
    }),
    [
      messages,
      isLoading,
      pendingConfirmations,
      sendMessage,
      approveToolCall,
      rejectToolCall,
      startNewSession,
      loadSession,
      uiActions,
      isSidebarOpen,
      toggleSidebar,
      sidebarWidth,
      handleSetSidebarWidth,
      activeTab,
      notifications,
      unreadNotificationCount,
      setActiveTab,
      markNotificationRead,
      markAllNotificationsRead,
      startConversationFromNotification,
      startReceiptSearch,
      startPartnerSearch,
      startFilePartnerSearch,
      startFileTransactionSearch,
      activeWandTargets,
      sidebarMode,
      sessions,
      currentSessionId,
      modelProvider,
    ]
  );

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}
