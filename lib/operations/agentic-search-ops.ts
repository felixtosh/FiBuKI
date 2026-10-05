/**
 * Agentic Search Operations
 *
 * CRUD operations for agent search sessions.
 * Sessions track the state of an agentic receipt search including:
 * - Searches performed
 * - Candidates found
 * - Nominations made
 * - Files connected
 */

import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  orderBy,
  limit,
} from "firebase/firestore";
import { OperationsContext } from "./types";
import {
  AgentSearchSession,
  AgentSearchSessionDoc,
} from "@/types/agentic-search";

// ============================================================================
// Session CRUD
// ============================================================================

/**
 * Generate a unique session ID
 */
export function generateSessionId(): string {
  return `sess_${Date.now()}_${crypto.randomUUID()}`;
}

/**
 * Get an active session for a transaction (if exists)
 */
export async function getActiveSessionForTransaction(
  ctx: OperationsContext,
  transactionId: string
): Promise<AgentSearchSession | null> {
  const sessionsRef = collection(ctx.db, "agentSearchSessions");
  const q = query(
    sessionsRef,
    where("userId", "==", ctx.userId),
    where("transactionId", "==", transactionId),
    where("status", "==", "active"),
    orderBy("createdAt", "desc"),
    limit(1)
  );

  const snapshot = await getDocs(q);
  if (snapshot.empty) return null;

  const docData = snapshot.docs[0].data() as AgentSearchSessionDoc;
  return convertSessionDocToSession(docData);
}

/**
 * Get session by ID
 */
export async function getSearchSession(
  ctx: OperationsContext,
  sessionId: string
): Promise<AgentSearchSession | null> {
  const docRef = doc(ctx.db, "agentSearchSessions", sessionId);
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) return null;

  const docData = snapshot.data() as AgentSearchSessionDoc;

  // Verify ownership
  if (docData.userId !== ctx.userId) return null;

  return convertSessionDocToSession(docData);
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Convert Firestore document to session object
 */
function convertSessionDocToSession(
  docData: AgentSearchSessionDoc
): AgentSearchSession {
  return {
    ...docData,
    transactionDate: docData.transactionDate.toDate(),
    searchesPerformed: docData.searchesPerformed.map((s) => ({
      ...s,
      at: s.at.toDate(),
    })),
    createdAt: docData.createdAt.toDate(),
    updatedAt: docData.updatedAt.toDate(),
  };
}
