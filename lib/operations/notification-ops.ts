import {
  collection,
  query,
  orderBy,
  where,
  getDocs,
  getDoc,
  doc,
  updateDoc,
  Timestamp,
  limit,
  writeBatch,
} from "firebase/firestore";
import {
  AutoActionNotification,
} from "@/types/notification";
import { OperationsContext } from "./types";

function getNotificationsCollection(userId: string) {
  return `users/${userId}/notifications`;
}

/**
 * List notifications for the current user
 */
export async function listNotifications(
  ctx: OperationsContext,
  options: { limit?: number; unreadOnly?: boolean } = {}
): Promise<AutoActionNotification[]> {
  const collectionPath = getNotificationsCollection(ctx.userId);

  let q;
  if (options.unreadOnly && options.limit) {
    q = query(
      collection(ctx.db, collectionPath),
      where("readAt", "==", null),
      orderBy("createdAt", "desc"),
      limit(options.limit)
    );
  } else if (options.unreadOnly) {
    q = query(
      collection(ctx.db, collectionPath),
      where("readAt", "==", null),
      orderBy("createdAt", "desc")
    );
  } else if (options.limit) {
    q = query(
      collection(ctx.db, collectionPath),
      orderBy("createdAt", "desc"),
      limit(options.limit)
    );
  } else {
    q = query(
      collection(ctx.db, collectionPath),
      orderBy("createdAt", "desc")
    );
  }

  const snapshot = await getDocs(q);

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as AutoActionNotification[];
}

/**
 * Get a single notification by ID
 */
export async function getNotification(
  ctx: OperationsContext,
  notificationId: string
): Promise<AutoActionNotification | null> {
  const collectionPath = getNotificationsCollection(ctx.userId);
  const docRef = doc(ctx.db, collectionPath, notificationId);
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) {
    return null;
  }

  return { id: snapshot.id, ...snapshot.data() } as AutoActionNotification;
}

/**
 * Mark a notification as read
 */
export async function markNotificationRead(
  ctx: OperationsContext,
  notificationId: string
): Promise<void> {
  const collectionPath = getNotificationsCollection(ctx.userId);
  const docRef = doc(ctx.db, collectionPath, notificationId);

  await updateDoc(docRef, {
    readAt: Timestamp.now(),
  });
}

/**
 * Mark all notifications as read
 */
export async function markAllNotificationsRead(
  ctx: OperationsContext
): Promise<void> {
  const collectionPath = getNotificationsCollection(ctx.userId);
  const q = query(
    collection(ctx.db, collectionPath),
    where("readAt", "==", null)
  );

  const snapshot = await getDocs(q);

  if (snapshot.empty) {
    return;
  }

  const batch = writeBatch(ctx.db);
  const now = Timestamp.now();

  snapshot.docs.forEach((docSnap) => {
    batch.update(docSnap.ref, { readAt: now });
  });

  await batch.commit();
}

/**
 * Get count of unread notifications
 */
export async function getUnreadNotificationCount(
  ctx: OperationsContext
): Promise<number> {
  const collectionPath = getNotificationsCollection(ctx.userId);
  const q = query(
    collection(ctx.db, collectionPath),
    where("readAt", "==", null)
  );

  const snapshot = await getDocs(q);
  return snapshot.size;
}
