import {
  collection,
  query,
  orderBy,
  where,
  getDocs,
  getDoc,
  doc,
} from "firebase/firestore";
import { ImportRecord } from "@/types/import";
import { OperationsContext } from "./types";

const IMPORTS_COLLECTION = "imports";

/**
 * List all imports for a source
 */
export async function listImports(
  ctx: OperationsContext,
  sourceId: string
): Promise<ImportRecord[]> {
  const q = query(
    collection(ctx.db, IMPORTS_COLLECTION),
    where("sourceId", "==", sourceId),
    where("userId", "==", ctx.userId),
    orderBy("createdAt", "desc")
  );

  const snapshot = await getDocs(q);
  return snapshot.docs.map((docSnap) => ({
    id: docSnap.id,
    ...docSnap.data(),
  })) as ImportRecord[];
}

/**
 * Get a single import record by ID
 */
export async function getImportRecord(
  ctx: OperationsContext,
  importId: string
): Promise<ImportRecord | null> {
  const docRef = doc(ctx.db, IMPORTS_COLLECTION, importId);
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) {
    return null;
  }

  const data = snapshot.data();
  if (data.userId !== ctx.userId) {
    return null;
  }

  return { id: snapshot.id, ...data } as ImportRecord;
}

