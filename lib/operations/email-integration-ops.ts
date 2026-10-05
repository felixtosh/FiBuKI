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
  arrayRemove,
} from "firebase/firestore";
import {
  EmailIntegration,
  EmailSearchPattern,
} from "@/types/email-integration";
import { OperationsContext } from "./types";

const INTEGRATIONS_COLLECTION = "emailIntegrations";

/**
 * List all active email integrations for the current user
 */
export async function listEmailIntegrations(
  ctx: OperationsContext
): Promise<EmailIntegration[]> {
  const q = query(
    collection(ctx.db, INTEGRATIONS_COLLECTION),
    where("userId", "==", ctx.userId),
    where("isActive", "==", true),
    orderBy("createdAt", "desc")
  );

  const snapshot = await getDocs(q);
  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as EmailIntegration[];
}

/**
 * Get a single email integration by ID
 */
export async function getEmailIntegration(
  ctx: OperationsContext,
  integrationId: string
): Promise<EmailIntegration | null> {
  const docRef = doc(ctx.db, INTEGRATIONS_COLLECTION, integrationId);
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) {
    return null;
  }

  const data = snapshot.data();
  // Verify ownership
  if (data.userId !== ctx.userId) {
    return null;
  }

  return { id: snapshot.id, ...data } as EmailIntegration;
}

/**
 * Get email integration by email address (to prevent duplicates)
 */
export async function getEmailIntegrationByEmail(
  ctx: OperationsContext,
  email: string
): Promise<EmailIntegration | null> {
  const q = query(
    collection(ctx.db, INTEGRATIONS_COLLECTION),
    where("userId", "==", ctx.userId),
    where("email", "==", email.toLowerCase()),
    where("isActive", "==", true)
  );

  const snapshot = await getDocs(q);
  if (snapshot.empty) {
    return null;
  }

  const doc = snapshot.docs[0];
  return { id: doc.id, ...doc.data() } as EmailIntegration;
}

/**
 * Find a disconnected integration by email (for reconnection detection).
 * Returns the most recently disconnected integration if multiple exist.
 */
export async function getDisconnectedIntegrationByEmail(
  ctx: OperationsContext,
  email: string
): Promise<EmailIntegration | null> {
  const q = query(
    collection(ctx.db, INTEGRATIONS_COLLECTION),
    where("userId", "==", ctx.userId),
    where("email", "==", email.toLowerCase()),
    where("isActive", "==", false)
  );

  const snapshot = await getDocs(q);
  if (snapshot.empty) {
    return null;
  }

  // Return the most recently disconnected one
  const docs = snapshot.docs.map((d) => ({
    id: d.id,
    ...d.data(),
  })) as EmailIntegration[];

  // Sort by disconnectedAt descending (most recent first)
  docs.sort((a, b) => {
    const aTime = a.disconnectedAt?.toMillis() || 0;
    const bTime = b.disconnectedAt?.toMillis() || 0;
    return bTime - aTime;
  });

  return docs[0] || null;
}

// ============================================================================
// Partner Email Search Pattern Operations
// ============================================================================

const PARTNERS_COLLECTION = "partners";

/**
 * Remove an email search pattern from a partner
 */
export async function removeEmailPatternFromPartner(
  ctx: OperationsContext,
  partnerId: string,
  patternIndex: number
): Promise<void> {
  const partnerRef = doc(ctx.db, PARTNERS_COLLECTION, partnerId);
  const partnerSnap = await getDoc(partnerRef);

  if (!partnerSnap.exists()) {
    throw new Error("Partner not found");
  }

  const partnerData = partnerSnap.data();
  if (partnerData.userId !== ctx.userId) {
    throw new Error("Partner not found");
  }

  const patterns =
    (partnerData.emailSearchPatterns as EmailSearchPattern[]) || [];
  if (patternIndex < 0 || patternIndex >= patterns.length) {
    throw new Error("Pattern not found");
  }

  // Remove the pattern at the specified index
  patterns.splice(patternIndex, 1);

  await updateDoc(partnerRef, {
    emailSearchPatterns: patterns,
    emailPatternsUpdatedAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
  });
}

/**
 * Get email search patterns for a partner
 */
export async function getEmailPatternsForPartner(
  ctx: OperationsContext,
  partnerId: string
): Promise<EmailSearchPattern[]> {
  const partnerRef = doc(ctx.db, PARTNERS_COLLECTION, partnerId);
  const partnerSnap = await getDoc(partnerRef);

  if (!partnerSnap.exists()) {
    return [];
  }

  const partnerData = partnerSnap.data();
  if (partnerData.userId !== ctx.userId) {
    return [];
  }

  return (partnerData.emailSearchPatterns as EmailSearchPattern[]) || [];
}
