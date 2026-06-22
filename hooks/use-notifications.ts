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
import { AutoActionNotification } from "@/types/notification";
import {
  OperationsContext,
  markAllNotificationsRead as markAllNotificationsReadOp,
  markNotificationRead as markNotificationReadOp,
} from "@/lib/operations";
import { useFirestoreCollection } from "@/lib/firebase/use-firestore-collection";
import { useAuth } from "@/components/auth";

const MAX_NOTIFICATIONS = 50;

function mapNotification(doc: QueryDocumentSnapshot): AutoActionNotification {
  return { id: doc.id, ...doc.data() } as AutoActionNotification;
}

export function useNotifications() {
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
            collection(db, `users/${userId}/notifications`),
            orderBy("createdAt", "desc"),
            limit(MAX_NOTIFICATIONS),
          )
        : null,
    [userId],
  );

  const { data: notifications, loading, error } = useFirestoreCollection(
    q,
    mapNotification,
  );

  const unreadCount = useMemo(
    () => notifications.filter((n) => !n.readAt).length,
    [notifications],
  );

  const markRead = useCallback(
    async (notificationId: string) => {
      await markNotificationReadOp(ctx, notificationId);
    },
    [ctx],
  );

  const markAllRead = useCallback(async () => {
    await markAllNotificationsReadOp(ctx);
  }, [ctx]);

  const getNotificationById = useCallback(
    (notificationId: string): AutoActionNotification | undefined => {
      return notifications.find((n) => n.id === notificationId);
    },
    [notifications],
  );

  return {
    notifications,
    unreadCount,
    loading,
    error,
    markRead,
    markAllRead,
    getNotificationById,
  };
}
