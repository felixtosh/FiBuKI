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
} from "firebase/firestore";
import { TransactionSource } from "@/types/source";
import { OperationsContext } from "./types";

const SOURCES_COLLECTION = "sources";

/**
 * List all active sources for the current user
 */
export async function listSources(ctx: OperationsContext): Promise<TransactionSource[]> {
  const q = query(
    collection(ctx.db, SOURCES_COLLECTION),
    where("userId", "==", ctx.userId),
    where("isActive", "==", true),
    orderBy("name", "asc")
  );

  const snapshot = await getDocs(q);
  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as TransactionSource[];
}

/**
 * Get a single source by ID
 */
export async function getSourceById(
  ctx: OperationsContext,
  sourceId: string
): Promise<TransactionSource | null> {
  const docRef = doc(ctx.db, SOURCES_COLLECTION, sourceId);
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) {
    return null;
  }

  const data = snapshot.data();
  // Verify ownership
  if (data.userId !== ctx.userId) {
    return null;
  }

  return { id: snapshot.id, ...data } as TransactionSource;
}

/**
 * Update a source
 */
export async function updateSource(
  ctx: OperationsContext,
  sourceId: string,
  data: Partial<Omit<TransactionSource, "id" | "userId" | "createdAt">>
): Promise<void> {
  // Verify ownership first
  const existing = await getSourceById(ctx, sourceId);
  if (!existing) {
    throw new Error(`Source ${sourceId} not found or access denied`);
  }

  const docRef = doc(ctx.db, SOURCES_COLLECTION, sourceId);
  await updateDoc(docRef, {
    ...data,
    updatedAt: Timestamp.now(),
  });
}
