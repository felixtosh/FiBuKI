"use client";

import { useCallback, useMemo } from "react";
import {
  collection,
  limit,
  orderBy,
  query,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { ChatSession } from "@/types/chat";
import {
  deleteChatSession,
  getChatMessages,
  serializeMessagesForSDK,
} from "@/lib/operations";
import { OperationsContext } from "@/lib/operations/types";
import { useFirestoreCollection } from "@/lib/firebase/use-firestore-collection";
import { useAuth } from "@/components/auth";

interface UseChatSessionsReturn {
  sessions: ChatSession[];
  isLoading: boolean;
  deleteSession: (sessionId: string) => Promise<void>;
  getSessionMessages: (
    sessionId: string,
  ) => Promise<ReturnType<typeof serializeMessagesForSDK>>;
}

function mapSession(doc: QueryDocumentSnapshot): ChatSession {
  return { id: doc.id, ...doc.data() } as ChatSession;
}

export function useChatSessions(): UseChatSessionsReturn {
  const { userId } = useAuth();

  const ctx: OperationsContext = useMemo(
    () => ({
      db,
      userId: userId ?? "",
    }),
    [userId],
  );

  const q = useMemo(
    () =>
      userId
        ? query(
            collection(db, `users/${userId}/chatSessions`),
            orderBy("updatedAt", "desc"),
            limit(50),
          )
        : null,
    [userId],
  );

  const { data: sessions, loading: isLoading } = useFirestoreCollection(
    q,
    mapSession,
  );

  const deleteSession = useCallback(
    async (sessionId: string) => {
      if (!userId) return;
      await deleteChatSession(ctx, sessionId);
    },
    [ctx, userId],
  );

  const getSessionMessages = useCallback(
    async (sessionId: string) => {
      if (!userId) return [];
      const messages = await getChatMessages(ctx, sessionId);
      return serializeMessagesForSDK(messages);
    },
    [ctx, userId],
  );

  return {
    sessions,
    isLoading,
    deleteSession,
    getSessionMessages,
  };
}
