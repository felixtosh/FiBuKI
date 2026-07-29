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
  setDoc,
  updateDoc,
  query,
  where,
  orderBy,
  limit,
  Timestamp,
  serverTimestamp,
} from "firebase/firestore";
import { OperationsContext } from "./types";
import {
  AgentSearchSession,
  AgentSearchSessionDoc,
  AgentSearchCandidate,
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
 * Create a new agentic search session
 */
export async function createSearchSession(
  ctx: OperationsContext,
  transactionId: string,
  transactionInfo: {
    name: string;
    amount: number;
    date: Date;
    partner?: string;
  }
): Promise<AgentSearchSession> {
  const sessionId = generateSessionId();
  const now = new Date();

  const session: AgentSearchSession = {
    sessionId,
    transactionId,
    userId: ctx.userId,
    transactionName: transactionInfo.name,
    transactionAmount: transactionInfo.amount,
    transactionDate: transactionInfo.date,
    transactionPartner: transactionInfo.partner,
    iteration: 0,
    maxIterations: 3,
    searchesPerformed: [],
    nominatedCandidates: [],
    filesConnected: [],
    status: "active",
    createdAt: now,
    updatedAt: now,
  };

  // Convert to Firestore format
  const sessionDoc: AgentSearchSessionDoc = {
    ...session,
    transactionDate: Timestamp.fromDate(transactionInfo.date),
    searchesPerformed: [],
    createdAt: Timestamp.fromDate(now),
    updatedAt: Timestamp.fromDate(now),
  };

  await setDoc(
    doc(ctx.db, "agentSearchSessions", sessionId),
    sessionDoc
  );

  return session;
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

/**
 * Record a search performed in the session
 */
export async function recordSearchPerformed(
  ctx: OperationsContext,
  sessionId: string,
  searchInfo: {
    type: string;
    query?: string;
    strategy?: string;
    candidatesFound: number;
  }
): Promise<void> {
  const session = await getSearchSession(ctx, sessionId);
  if (!session) throw new Error("Session not found");

  const updatedSearches = [
    ...session.searchesPerformed,
    {
      ...searchInfo,
      at: new Date(),
    },
  ];

  await updateDoc(doc(ctx.db, "agentSearchSessions", sessionId), {
    searchesPerformed: updatedSearches.map((s) => ({
      ...s,
      at: Timestamp.fromDate(s.at),
    })),
    updatedAt: serverTimestamp(),
  });
}

/**
 * Increment the iteration counter
 */
export async function incrementIteration(
  ctx: OperationsContext,
  sessionId: string
): Promise<number> {
  const session = await getSearchSession(ctx, sessionId);
  if (!session) throw new Error("Session not found");

  const newIteration = session.iteration + 1;

  // Check if we've hit max iterations
  const newStatus =
    newIteration >= session.maxIterations
      ? "max_iterations_reached"
      : session.status;

  await updateDoc(doc(ctx.db, "agentSearchSessions", sessionId), {
    iteration: newIteration,
    status: newStatus,
    updatedAt: serverTimestamp(),
  });

  return newIteration;
}

/**
 * Add nominated candidates to session
 */
export async function addNominatedCandidates(
  ctx: OperationsContext,
  sessionId: string,
  candidates: AgentSearchCandidate[]
): Promise<void> {
  const session = await getSearchSession(ctx, sessionId);
  if (!session) throw new Error("Session not found");

  // Mark candidates as nominated
  const nominatedCandidates = candidates.map((c) => ({
    ...c,
    nominated: true,
    nominatedAt: new Date(),
    downloadStatus: "pending" as const,
  }));

  const updatedNominations = [
    ...session.nominatedCandidates,
    ...nominatedCandidates,
  ];

  await updateDoc(doc(ctx.db, "agentSearchSessions", sessionId), {
    nominatedCandidates: updatedNominations,
    updatedAt: serverTimestamp(),
  });
}

/**
 * Update download status for a candidate
 */
export async function updateCandidateDownloadStatus(
  ctx: OperationsContext,
  sessionId: string,
  candidateId: string,
  status: "pending" | "downloading" | "completed" | "failed",
  fileId?: string
): Promise<void> {
  const session = await getSearchSession(ctx, sessionId);
  if (!session) throw new Error("Session not found");

  const updatedCandidates = session.nominatedCandidates.map((c) => {
    if (c.id === candidateId) {
      return {
        ...c,
        downloadStatus: status,
        downloadedFileId: fileId,
      };
    }
    return c;
  });

  await updateDoc(doc(ctx.db, "agentSearchSessions", sessionId), {
    nominatedCandidates: updatedCandidates,
    updatedAt: serverTimestamp(),
  });
}

/**
 * Record a file connection
 */
export async function recordFileConnected(
  ctx: OperationsContext,
  sessionId: string,
  fileId: string
): Promise<void> {
  const session = await getSearchSession(ctx, sessionId);
  if (!session) throw new Error("Session not found");

  const updatedFilesConnected = [...session.filesConnected, fileId];

  await updateDoc(doc(ctx.db, "agentSearchSessions", sessionId), {
    filesConnected: updatedFilesConnected,
    updatedAt: serverTimestamp(),
  });
}

/**
 * Complete the session
 */
export async function completeSession(
  ctx: OperationsContext,
  sessionId: string,
  status: "completed" | "max_iterations_reached" | "user_cancelled" = "completed"
): Promise<void> {
  await updateDoc(doc(ctx.db, "agentSearchSessions", sessionId), {
    status,
    updatedAt: serverTimestamp(),
  });
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
