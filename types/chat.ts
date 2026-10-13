import { Timestamp } from "firebase/firestore";
import { AutoActionNotification } from "./notification";

export type ChatTab = "notifications" | "chat" | "history";
export type SidebarMode = "chat" | "onboarding";

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

  /** The chat turn an assistant message answered: its trace's id, which feedback names. */
  turnId?: string;
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

/** Choice cards answered in this view: token -> option id. */
export type AnsweredChoices = Map<string, string>;
/** Messages written while a turn runs, in order. */
export type QueuedMessages = string[];
/** Choice card tokens, e.g. those the User put aside. */
export type ChoiceTokens = Set<string>;
/** The choice card or confirmation still waiting in BuKI's last reply. */
export interface OpenChoice {
  token: string;
  /** The tool result: awaiting_choice or awaiting_confirmation. */
  result: Record<string, unknown>;
}
/** Thumbs given in this view: turnId -> rating. */
export type TurnRatings = Map<string, "up" | "down">;

/** A click on a choice card: the token the card carries, the option, and what the User sees as their message. */
export interface ChoiceClick {
  token: string;
  optionId: string;
  label: string;
  feedback?: string;
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

  // Actions
  sendMessage: (content: string) => Promise<void>;
  /** Written while BuKI works: sent together when the turn ends, or at once on Stop. */
  queuedMessages: QueuedMessages;
  queueMessage: (content: string) => void;
  removeQueuedMessage: (index: number) => void;
  /** Stop the running turn, on the server too; a queued message is sent right after. */
  stopTurn: () => void;
  /** Answer a choice card or a confirmation (lib/agent/choices.ts): the click continues the turn. */
  chooseOption: (choice: ChoiceClick) => Promise<void>;
  /** The card still waiting for the User, docked where the input is; null when none. */
  openChoice: OpenChoice | null;
  /** Put the open card aside: it stays in the message and the input comes back. */
  dismissChoice: (token: string) => void;
  /** Choice cards already answered in this view, by token. */
  answeredChoices: AnsweredChoices;
  /** Thumbs on one turn's reply; stored on its trace. */
  rateTurn: (turnId: string, rating: "up" | "down", comment?: string) => Promise<void>;
  /** The rating given to each turn in this view. */
  turnRatings: TurnRatings;
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

}
