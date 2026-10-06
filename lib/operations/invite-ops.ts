import {
  collection,
  doc,
  setDoc,
  deleteDoc,
  getDocs,
  getDoc,
  query,
  where,
  orderBy,
  Timestamp,
} from "firebase/firestore";
import { OperationsContext } from "./types";
import { AllowedEmail } from "@/types/auth";

/**
 * Add an email to the allowed list (invite a user)
 */
export async function addAllowedEmail(
  ctx: OperationsContext,
  email: string
): Promise<AllowedEmail> {
  const normalizedEmail = email.toLowerCase().trim();
  const emailsRef = collection(ctx.db, "allowedEmails");

  // Check if already exists
  const existingQuery = query(
    emailsRef,
    where("email", "==", normalizedEmail)
  );
  const existing = await getDocs(existingQuery);

  if (!existing.empty) {
    throw new Error("This email has already been invited");
  }

  const docRef = doc(emailsRef);
  const invite: Omit<AllowedEmail, "id"> = {
    email: normalizedEmail,
    addedBy: ctx.userId,
    addedAt: Timestamp.now(),
  };

  await setDoc(docRef, invite);

  return {
    id: docRef.id,
    ...invite,
  };
}

/**
 * Remove an email from the allowed list
 */
export async function removeAllowedEmail(
  ctx: OperationsContext,
  emailOrId: string
): Promise<void> {
  const emailsRef = collection(ctx.db, "allowedEmails");

  // Try to find by ID first
  const docRef = doc(emailsRef, emailOrId);
  const docSnap = await getDoc(docRef);

  if (docSnap.exists()) {
    await deleteDoc(docRef);
    return;
  }

  // Otherwise find by email
  const normalizedEmail = emailOrId.toLowerCase().trim();
  const emailQuery = query(emailsRef, where("email", "==", normalizedEmail));
  const results = await getDocs(emailQuery);

  if (results.empty) {
    throw new Error("Email not found in allowed list");
  }

  await deleteDoc(results.docs[0].ref);
}

/**
 * List all allowed emails (invites)
 */
export async function listAllowedEmails(
  ctx: OperationsContext
): Promise<AllowedEmail[]> {
  const emailsRef = collection(ctx.db, "allowedEmails");
  const q = query(emailsRef, orderBy("addedAt", "desc"));
  const snapshot = await getDocs(q);

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as AllowedEmail[];
}

/**
 * Check if an email is allowed to register (public function, no auth required)
 * Note: This is also implemented as a Cloud Function for security
 */
export async function isEmailAllowed(
  ctx: OperationsContext,
  email: string
): Promise<boolean> {
  const normalizedEmail = email.toLowerCase().trim();
  const emailsRef = collection(ctx.db, "allowedEmails");

  const emailQuery = query(
    emailsRef,
    where("email", "==", normalizedEmail),
    where("usedAt", "==", null)
  );
  const results = await getDocs(emailQuery);

  return !results.empty;
}

/**
 * Get pending invites (not yet used)
 */
export async function getPendingInvites(
  ctx: OperationsContext
): Promise<AllowedEmail[]> {
  const emailsRef = collection(ctx.db, "allowedEmails");
  const q = query(
    emailsRef,
    where("usedAt", "==", null),
    orderBy("addedAt", "desc")
  );
  const snapshot = await getDocs(q);

  return snapshot.docs.map((doc) => ({
    id: doc.id,
    ...doc.data(),
  })) as AllowedEmail[];
}
