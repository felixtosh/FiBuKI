import { Timestamp } from "firebase/firestore";
import { AutoActionNotification } from "./notification";

export type ChatTab = "notifications" | "chat" | "history";
export type SidebarMode = "chat" | "onboarding";
export type ModelProvider = "anthropic" | "gemini";

/**
 * A part of a message - either text or a tool call (in chronological order)
 * Runtime format with full toolCall object
 */
export type MessagePart =
  | { type: "text"; text: string }
  | { type: "tool"; toolCall: ToolCall };

/**
 * Stored format for parts - lighter weight for Firestore storage
 * Tool calls only store ID and name, full data is in toolCalls array
 */
export type StoredMessagePart =
  | { type: "text"; text: string }
  | { type: "tool"; toolCallId: string; toolName: string };

/**
 * A single message in a chat conversation (storage format)
 * Parts can be either runtime format or stored format for Firestore flexibility
 */
export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system";
  content: string;
  createdAt: Date | Timestamp;

  /** Sequence number for deterministic ordering (auto-incremented per session) */
  sequence?: number;

  /** Ordered parts for rendering (text and tool calls in chronological order)
   * Can be either runtime format (MessagePart) or stored format (StoredMessagePart) */
  parts?: MessagePart[] | StoredMessagePart[];

  /** Tool calls made by the assistant (legacy, for backwards compat) */
  toolCalls?: ToolCall[];

  /** Results of tool executions */
  toolResults?: ToolResult[];
}

/**
 * Chat message with parts transformed to runtime format (used in context)
 * Parts are always full MessagePart[] with toolCall objects
 */
export interface RuntimeChatMessage extends Omit<ChatMessage, "parts"> {
  parts?: MessagePart[];
}

/**
 * A tool call made by the AI assistant
 */
export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  result?: unknown;
  status: "pending" | "approved" | "rejected" | "executed";
  requiresConfirmation: boolean;
}

/**
 * Result of a tool execution
 */
export interface ToolResult {
  toolCallId: string;
  result: unknown;
  error?: string;
}

/**
 * A chat session containing multiple messages
 */
export interface ChatSession {
  id: string;
  userId: string;
  title: string;
  createdAt: Timestamp;
  updatedAt: Timestamp;
  messageCount: number;
  lastMessagePreview?: string;
}

/**
 * UI action that the chat can trigger
 */
export interface UIAction {
  type: "navigate" | "openSheet" | "closeSheet" | "scrollTo" | "highlight" | "notification";
  payload: Record<string, unknown>;
}

/**
 * Actions available for UI control from chat
 */
export interface UIControlActions {
  navigateTo: (path: string) => void;
  openTransactionSheet: (transactionId: string) => void;
  closeTransactionSheet: () => void;
  scrollToTransaction: (transactionId: string) => void;
  highlightTransaction: (transactionId: string) => void;
  showNotification: (message: string, type: "success" | "error" | "info") => void;
  openFile: (fileId: string) => void;
}

/**
 * Chat context value provided by ChatProvider
 */
export interface ChatContextValue {
  // State
  messages: RuntimeChatMessage[];
  isLoading: boolean;
  isStreaming: boolean;
  currentSession: ChatSession | null;
  sessions: ChatSession[];
  currentSessionId: string | null;
  pendingConfirmations: ToolCall[];

  // Actions
  sendMessage: (content: string) => Promise<void>;
  approveToolCall: (toolCallId: string) => Promise<void>;
  rejectToolCall: (toolCallId: string) => void;
  startNewSession: () => Promise<void>;
  loadSession: (sessionId: string) => Promise<void>;

  // UI Control
  uiActions: UIControlActions;

  // Sidebar state
  isSidebarOpen: boolean;
  toggleSidebar: () => void;
  sidebarWidth: number;
  setSidebarWidth: (width: number) => void;

  // Tabs & Notifications
  activeTab: ChatTab;
  setActiveTab: (tab: ChatTab) => void;
  notifications: AutoActionNotification[];
  unreadNotificationCount: number;
  markNotificationRead: (id: string) => Promise<void>;
  markAllNotificationsRead: () => Promise<void>;
  startConversationFromNotification: (notification: AutoActionNotification) => void;

  // Agentic search (via workers)
  startReceiptSearch: (transactionId: string) => void;
  startPartnerSearch: (transactionId: string) => void;
  startFilePartnerSearch: (fileId: string) => void;
  startFileTransactionSearch: (
    fileId: string,
    fileInfo?: {
      fileName?: string;
      amount?: number;
      currency?: string;
      date?: string;
      partner?: string;
    }
  ) => void;
  /** Entity IDs with running wand searches */
  activeWandTargets: Set<string>;

  // Sidebar mode (chat vs onboarding)
  sidebarMode: SidebarMode;
  setSidebarMode: (mode: SidebarMode) => void;

  // Model selection
  modelProvider: ModelProvider;
  setModelProvider: (provider: ModelProvider) => void;

}
