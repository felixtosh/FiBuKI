import {
  collection,
  query,
  orderBy,
  where,
  getDocs,
  getDoc,
  doc,
  updateDoc,
  addDoc,
  Timestamp,
  limit as firestoreLimit,
  deleteDoc,
} from "firebase/firestore";
import { nanoid } from "nanoid";
import {
  InboundEmailAddress,
  InboundEmailLog,
  CreateInboundEmailAddressData,
  UpdateInboundEmailAddressData,
  InboundEmailStats,
} from "@/types/email-inbound";
import { OperationsContext } from "./types";

const INBOUND_ADDRESSES_COLLECTION = "inboundEmailAddresses";
const INBOUND_LOGS_COLLECTION = "inboundEmailLogs";

/** Email domain for inbound addresses */
const INBOUND_EMAIL_DOMAIN = "fibuki.com";

/** Default daily email limit */
const DEFAULT_DAILY_LIMIT = 100;

// ============================================================================
// Inbound Email Address Operations
// ============================================================================

/**
 * List all inbound email addresses for the current user
 */
export async function listInboundEmailAddresses(
  ctx: OperationsContext
): Promise<InboundEmailAddress[]> {
  const q = query(
    collection(ctx.db, INBOUND_ADDRESSES_COLLECTION),
    where("userId", "==", ctx.userId),
    orderBy("createdAt", "desc")
  );

  const snapshot = await getDocs(q);
  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as InboundEmailAddress[];
}

/**
 * List only active inbound email addresses
 */
export async function listActiveInboundEmailAddresses(
  ctx: OperationsContext
): Promise<InboundEmailAddress[]> {
  const q = query(
    collection(ctx.db, INBOUND_ADDRESSES_COLLECTION),
    where("userId", "==", ctx.userId),
    where("isActive", "==", true),
    orderBy("createdAt", "desc")
  );

  const snapshot = await getDocs(q);
  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as InboundEmailAddress[];
}

/**
 * Get a single inbound email address by ID
 */
export async function getInboundEmailAddress(
  ctx: OperationsContext,
  addressId: string
): Promise<InboundEmailAddress | null> {
  const docRef = doc(ctx.db, INBOUND_ADDRESSES_COLLECTION, addressId);
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) {
    return null;
  }

  const data = snapshot.data();
  // Verify ownership
  if (data.userId !== ctx.userId) {
    return null;
  }

  return { id: snapshot.id, ...data } as InboundEmailAddress;
}

/**
 * Get inbound email address by email prefix (for webhook lookup)
 * Note: This does NOT check userId - used by webhook to find any matching address
 */
export async function getInboundEmailAddressByPrefix(
  ctx: OperationsContext,
  emailPrefix: string
): Promise<InboundEmailAddress | null> {
  const q = query(
    collection(ctx.db, INBOUND_ADDRESSES_COLLECTION),
    where("emailPrefix", "==", emailPrefix),
    where("isActive", "==", true),
    firestoreLimit(1)
  );

  const snapshot = await getDocs(q);
  if (snapshot.empty) {
    return null;
  }

  const docData = snapshot.docs[0];
  return { id: docData.id, ...docData.data() } as InboundEmailAddress;
}

/**
 * Generate a unique email prefix
 */
function generateEmailPrefix(): string {
  // 21 characters = ~126 bits of entropy
  return nanoid(21);
}

/**
 * Create a new inbound email address
 */
export async function createInboundEmailAddress(
  ctx: OperationsContext,
  data: CreateInboundEmailAddressData = {}
): Promise<{ id: string; email: string }> {
  // Generate unique email prefix
  const emailPrefix = generateEmailPrefix();
  const email = `invoices-${emailPrefix}@${INBOUND_EMAIL_DOMAIN}`;

  const now = Timestamp.now();

  // Build the document, excluding undefined fields (Firestore doesn't accept undefined)
  const newAddress: Record<string, unknown> = {
    userId: ctx.userId,
    email,
    emailPrefix,
    isActive: true,
    emailsReceived: 0,
    filesCreated: 0,
    dailyLimit: data.dailyLimit || DEFAULT_DAILY_LIMIT,
    todayCount: 0,
    createdAt: now,
    updatedAt: now,
  };

  // Only add optional fields if they have values
  if (data.displayName) {
    newAddress.displayName = data.displayName;
  }
  if (data.allowedDomains && data.allowedDomains.length > 0) {
    newAddress.allowedDomains = data.allowedDomains;
  }

  const docRef = await addDoc(
    collection(ctx.db, INBOUND_ADDRESSES_COLLECTION),
    newAddress
  );

  return { id: docRef.id, email };
}

/**
 * Update an inbound email address
 */
export async function updateInboundEmailAddress(
  ctx: OperationsContext,
  addressId: string,
  updates: UpdateInboundEmailAddressData
): Promise<void> {
  // Verify ownership first
  const existing = await getInboundEmailAddress(ctx, addressId);
  if (!existing) {
    throw new Error("Inbound email address not found");
  }

  const docRef = doc(ctx.db, INBOUND_ADDRESSES_COLLECTION, addressId);
  await updateDoc(docRef, {
    ...updates,
    updatedAt: Timestamp.now(),
  });
}

/**
 * Regenerate an inbound email address (creates new prefix, deactivates old one)
 */
export async function regenerateInboundEmailAddress(
  ctx: OperationsContext,
  addressId: string
): Promise<{ id: string; email: string }> {
  // Verify ownership and deactivate old address
  const existing = await getInboundEmailAddress(ctx, addressId);
  if (!existing) {
    throw new Error("Inbound email address not found");
  }

  // Deactivate old address
  const oldDocRef = doc(ctx.db, INBOUND_ADDRESSES_COLLECTION, addressId);
  await updateDoc(oldDocRef, {
    isActive: false,
    updatedAt: Timestamp.now(),
  });

  // Create new address with same settings
  return createInboundEmailAddress(ctx, {
    displayName: existing.displayName,
    allowedDomains: existing.allowedDomains,
    dailyLimit: existing.dailyLimit,
  });
}

/**
 * Delete an inbound email address (soft delete - sets isActive to false)
 */
export async function deleteInboundEmailAddress(
  ctx: OperationsContext,
  addressId: string
): Promise<void> {
  const existing = await getInboundEmailAddress(ctx, addressId);
  if (!existing) {
    throw new Error("Inbound email address not found");
  }

  const docRef = doc(ctx.db, INBOUND_ADDRESSES_COLLECTION, addressId);
  await updateDoc(docRef, {
    isActive: false,
    updatedAt: Timestamp.now(),
  });
}

/**
 * Pause an inbound email address (stops accepting emails)
 */
export async function pauseInboundEmailAddress(
  ctx: OperationsContext,
  addressId: string
): Promise<void> {
  const existing = await getInboundEmailAddress(ctx, addressId);
  if (!existing) {
    throw new Error("Inbound email address not found");
  }

  const docRef = doc(ctx.db, INBOUND_ADDRESSES_COLLECTION, addressId);
  await updateDoc(docRef, {
    isActive: false,
    updatedAt: Timestamp.now(),
  });
}

/**
 * Resume an inbound email address (starts accepting emails)
 */
export async function resumeInboundEmailAddress(
  ctx: OperationsContext,
  addressId: string
): Promise<void> {
  const existing = await getInboundEmailAddress(ctx, addressId);
  if (!existing) {
    throw new Error("Inbound email address not found");
  }

  const docRef = doc(ctx.db, INBOUND_ADDRESSES_COLLECTION, addressId);
  await updateDoc(docRef, {
    isActive: true,
    updatedAt: Timestamp.now(),
  });
}

// ============================================================================
// Stats and Rate Limiting Operations (used by webhook)
// ============================================================================

/**
 * Check if address is within daily rate limit
 * Returns { allowed: true } if allowed, or { allowed: false, reason: string } if not
 */
export async function checkInboundRateLimit(
  ctx: OperationsContext,
  addressId: string
): Promise<{ allowed: boolean; reason?: string }> {
  const docRef = doc(ctx.db, INBOUND_ADDRESSES_COLLECTION, addressId);
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) {
    return { allowed: false, reason: "Address not found" };
  }

  const data = snapshot.data() as InboundEmailAddress;

  if (!data.isActive) {
    return { allowed: false, reason: "Address is inactive" };
  }

  const today = new Date().toISOString().split("T")[0]; // YYYY-MM-DD

  // Reset count if it's a new day
  if (data.todayDate !== today) {
    return { allowed: true };
  }

  // Check if within limit
  if (data.todayCount >= data.dailyLimit) {
    return { allowed: false, reason: "Daily limit exceeded" };
  }

  return { allowed: true };
}

/**
 * Check if sender domain is allowed
 */
export function checkSenderDomainAllowed(
  address: InboundEmailAddress,
  senderEmail: string
): boolean {
  // If no allowed domains specified, allow all
  if (!address.allowedDomains || address.allowedDomains.length === 0) {
    return true;
  }

  // Extract domain from sender email
  const senderDomain = senderEmail.split("@")[1]?.toLowerCase();
  if (!senderDomain) {
    return false;
  }

  return address.allowedDomains.some(
    (d) => d.toLowerCase() === senderDomain
  );
}

/**
 * Increment email stats after processing (called by webhook)
 */
export async function incrementInboundEmailStats(
  ctx: OperationsContext,
  addressId: string,
  filesCreated: number
): Promise<void> {
  const docRef = doc(ctx.db, INBOUND_ADDRESSES_COLLECTION, addressId);
  const snapshot = await getDoc(docRef);

  if (!snapshot.exists()) {
    return;
  }

  const data = snapshot.data() as InboundEmailAddress;
  const today = new Date().toISOString().split("T")[0];

  // Calculate new todayCount (reset if new day)
  const newTodayCount =
    data.todayDate === today ? data.todayCount + 1 : 1;

  await updateDoc(docRef, {
    emailsReceived: data.emailsReceived + 1,
    filesCreated: data.filesCreated + filesCreated,
    lastEmailAt: Timestamp.now(),
    todayCount: newTodayCount,
    todayDate: today,
    updatedAt: Timestamp.now(),
  });
}

/**
 * Get stats summary for an inbound email address
 */
export async function getInboundEmailStats(
  ctx: OperationsContext,
  addressId: string
): Promise<InboundEmailStats | null> {
  const address = await getInboundEmailAddress(ctx, addressId);
  if (!address) {
    return null;
  }

  const today = new Date().toISOString().split("T")[0];

  return {
    totalEmails: address.emailsReceived,
    totalFiles: address.filesCreated,
    todayEmails: address.todayDate === today ? address.todayCount : 0,
    dailyLimit: address.dailyLimit,
    lastEmailAt: address.lastEmailAt,
  };
}

// ============================================================================
// Inbound Email Log Operations
// ============================================================================

/**
 * Create a log entry for a received email
 */
export async function createInboundEmailLog(
  ctx: OperationsContext,
  data: Omit<InboundEmailLog, "id" | "createdAt">
): Promise<string> {
  const now = Timestamp.now();
  const logData = {
    ...data,
    createdAt: now,
  };

  const docRef = await addDoc(
    collection(ctx.db, INBOUND_LOGS_COLLECTION),
    logData
  );

  return docRef.id;
}

/**
 * Update a log entry (e.g., mark as completed)
 */
export async function updateInboundEmailLog(
  ctx: OperationsContext,
  logId: string,
  updates: Partial<
    Pick<
      InboundEmailLog,
      | "status"
      | "filesCreated"
      | "bodyConvertedToFile"
      | "attachmentsProcessed"
      | "error"
      | "rejectionReason"
    >
  >
): Promise<void> {
  const docRef = doc(ctx.db, INBOUND_LOGS_COLLECTION, logId);
  await updateDoc(docRef, updates);
}

/**
 * List logs for an inbound email address
 */
export async function listInboundEmailLogs(
  ctx: OperationsContext,
  addressId: string,
  limit: number = 50
): Promise<InboundEmailLog[]> {
  const q = query(
    collection(ctx.db, INBOUND_LOGS_COLLECTION),
    where("userId", "==", ctx.userId),
    where("inboundAddressId", "==", addressId),
    orderBy("receivedAt", "desc"),
    firestoreLimit(limit)
  );

  const snapshot = await getDocs(q);
  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as InboundEmailLog[];
}

/**
 * Check if a message has already been processed (deduplication)
 */
export async function checkInboundEmailDuplicate(
  ctx: OperationsContext,
  addressId: string,
  messageId: string
): Promise<boolean> {
  const q = query(
    collection(ctx.db, INBOUND_LOGS_COLLECTION),
    where("inboundAddressId", "==", addressId),
    where("messageId", "==", messageId),
    firestoreLimit(1)
  );

  const snapshot = await getDocs(q);
  return !snapshot.empty;
}

// ============================================================================
// Daily Reset Operation (for scheduled function)
// ============================================================================

/**
 * Reset daily counts for all addresses (called by scheduled function)
 * This runs server-side without user context
 */
export async function resetAllDailyCounts(
  db: OperationsContext["db"]
): Promise<number> {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split("T")[0];

  // Find all addresses with yesterday's date (need reset)
  const q = query(
    collection(db, INBOUND_ADDRESSES_COLLECTION),
    where("todayDate", "==", yesterdayStr)
  );

  const snapshot = await getDocs(q);
  let resetCount = 0;

  for (const docSnap of snapshot.docs) {
    await updateDoc(docSnap.ref, {
      todayCount: 0,
      todayDate: null,
    });
    resetCount++;
  }

  return resetCount;
}
