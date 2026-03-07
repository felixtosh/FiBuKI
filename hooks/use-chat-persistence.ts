"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { db } from "@/lib/firebase/config";
import { ChatSession, ChatMessage } from "@/types/chat";
import {
  OperationsContext,
  getChatMessages,
  createChatSession,
  addChatMessage,
  listChatSessions,
  serializeMessagesForSDK,
} from "@/lib/operations";
import { useAuth } from "@/components/auth";

export interface ChatPersistenceState {
  currentSessionId: string | null;
  isLoading: boolean;
  sessions: ChatSession[];
}

export function useChatPersistence() {
  const { userId } = useAuth();
  const [state, setState] = useState<ChatPersistenceState>({
    currentSessionId: null,
    isLoading: true,
    sessions: [],
  });

  // Operations context
  const ctx: OperationsContext = useMemo(
    () => ({
      db,
      userId: userId ?? "",
    }),
    [userId]
  );

  // Keep current session in a ref so callbacks can reliably read latest value.
  const currentSessionIdRef = useRef<string | null>(state.currentSessionId);
  useEffect(() => {
    currentSessionIdRef.current = state.currentSessionId;
  }, [state.currentSessionId]);

  // Load most recent session on mount (do not auto-create empty sessions).
  useEffect(() => {
    if (!userId) {
      setState({ currentSessionId: null, isLoading: false, sessions: [] });
      return;
    }

    const loadInitialSession = async () => {
      try {
        const sessions = await listChatSessions(ctx, { limit: 10 });
        setState({
          currentSessionId: sessions[0]?.id ?? null,
          isLoading: false,
          sessions,
        });
      } catch (error) {
        console.error("Failed to load initial session:", error);
        setState((s) => ({ ...s, isLoading: false }));
      }
    };

    loadInitialSession();
  }, [ctx, userId]);

  // Load messages for a session
  const loadSessionMessages = useCallback(
    async (sessionId: string): Promise<ChatMessage[]> => {
      try {
        const messages = await getChatMessages(ctx, sessionId);
        return messages;
      } catch (error) {
        console.error("Failed to load messages:", error);
        return [];
      }
    },
    [ctx]
  );

  // Get messages in SDK format for initializing useChat
  const getInitialMessages = useCallback(
    async (sessionId: string) => {
      const messages = await loadSessionMessages(sessionId);
      return serializeMessagesForSDK(messages);
    },
    [loadSessionMessages]
  );

  // Switch to a different session (or null for a draft/new conversation)
  const switchSession = useCallback(
    async (sessionId: string | null) => {
      currentSessionIdRef.current = sessionId;
      setState((s) => ({
        ...s,
        currentSessionId: sessionId,
        isLoading: true,
      }));

      // Messages will be loaded by the provider
      setState((s) => ({
        ...s,
        isLoading: false,
      }));
    },
    []
  );

  // Save a message to the current session
  const saveMessage = useCallback(
    async (message: Omit<ChatMessage, "id" | "createdAt">) => {
      try {
        let sessionId = currentSessionIdRef.current;

        // Lazily create a chat session on first message from a draft conversation.
        if (!sessionId) {
          sessionId = await createChatSession(ctx);
          currentSessionIdRef.current = sessionId;
          setState((s) => ({
            ...s,
            currentSessionId: sessionId,
          }));
        }

        await addChatMessage(ctx, sessionId, message);
      } catch (error) {
        console.error("Failed to save message:", error);
      }
    },
    [ctx]
  );

  return {
    currentSessionId: state.currentSessionId,
    isLoading: state.isLoading,
    sessions: state.sessions,
    loadSessionMessages,
    getInitialMessages,
    switchSession,
    saveMessage,
  };
}
