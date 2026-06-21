import { onCall, HttpsError } from "firebase-functions/v2/https";
import { defineSecret } from "firebase-functions/params";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { sendInviteEmail } from "./sendInviteEmail";

const resendApiKey = defineSecret("RESEND_API_KEY");

const db = getFirestore();

const FIREBASE_PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "taxstudio-f12fb";
const CORS_ORIGINS = [
  process.env.APP_URL || "https://fibuki.com",
  `https://${FIREBASE_PROJECT_ID}.firebaseapp.com`,
  `https://${FIREBASE_PROJECT_ID}.web.app`,
  "http://localhost:3000",
];

/**
 * Submit an access request from an unapproved OAuth user.
 * Deduplicates by email — if a pending request already exists, updates its timestamp.
 */
export const submitAccessRequest = onCall(
  {
    region: "europe-west1",
    cors: CORS_ORIGINS,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be authenticated");
    }

    const { provider } = request.data;
    if (!provider || !["google", "github"].includes(provider)) {
      throw new HttpsError("invalid-argument", "provider must be 'google' or 'github'");
    }

    const email = request.auth.token.email;
    if (!email) {
      throw new HttpsError("invalid-argument", "User has no email");
    }

    const normalizedEmail = email.toLowerCase().trim();
    const displayName = request.auth.token.name || null;
    const photoURL = request.auth.token.picture || null;

    // Check for existing pending request with same email
    const existingQuery = await db
      .collection("accessRequests")
      .where("email", "==", normalizedEmail)
      .where("status", "==", "pending")
      .limit(1)
      .get();

    if (!existingQuery.empty) {
      // Update timestamp on existing request
      const existingDoc = existingQuery.docs[0];
      await existingDoc.ref.update({
        requestedAt: FieldValue.serverTimestamp(),
        displayName,
        photoURL,
        provider,
      });
      return { success: true, requestId: existingDoc.id };
    }

    // Create new request
    const docRef = db.collection("accessRequests").doc();
    await docRef.set({
      email: normalizedEmail,
      displayName,
      photoURL,
      provider,
      requestedAt: FieldValue.serverTimestamp(),
      status: "pending",
    });

    return { success: true, requestId: docRef.id };
  }
);

/**
 * Approve an access request (admin only).
 * Creates an allowedEmails doc so the user can sign in next time.
 */
export const approveAccessRequest = onCall(
  {
    region: "europe-west1",
    cors: CORS_ORIGINS,
    secrets: [resendApiKey],
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be authenticated");
    }
    if (!request.auth.token.admin) {
      throw new HttpsError("permission-denied", "Admin only");
    }

    const { requestId } = request.data;
    if (!requestId || typeof requestId !== "string") {
      throw new HttpsError("invalid-argument", "requestId is required");
    }

    const requestRef = db.collection("accessRequests").doc(requestId);
    const requestDoc = await requestRef.get();

    if (!requestDoc.exists) {
      throw new HttpsError("not-found", "Access request not found");
    }

    const data = requestDoc.data()!;
    if (data.status !== "pending") {
      throw new HttpsError("failed-precondition", "Request is not pending");
    }

    // Create allowedEmails doc if not already there
    const existingAllowed = await db
      .collection("allowedEmails")
      .where("email", "==", data.email)
      .limit(1)
      .get();

    if (existingAllowed.empty) {
      await db.collection("allowedEmails").doc().set({
        email: data.email,
        addedBy: request.auth.uid,
        addedAt: FieldValue.serverTimestamp(),
      });
    }

    // Mark request as approved
    await requestRef.update({
      status: "approved",
      resolvedAt: FieldValue.serverTimestamp(),
      resolvedBy: request.auth.uid,
    });

    // Fire-and-forget invite email
    sendInviteEmail(data.email).catch((err) =>
      console.error("[approveAccessRequest] Failed to send invite email:", err)
    );

    return { success: true };
  }
);

/**
 * Dismiss an access request (admin only).
 */
export const dismissAccessRequest = onCall(
  {
    region: "europe-west1",
    cors: CORS_ORIGINS,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be authenticated");
    }
    if (!request.auth.token.admin) {
      throw new HttpsError("permission-denied", "Admin only");
    }

    const { requestId } = request.data;
    if (!requestId || typeof requestId !== "string") {
      throw new HttpsError("invalid-argument", "requestId is required");
    }

    const requestRef = db.collection("accessRequests").doc(requestId);
    const requestDoc = await requestRef.get();

    if (!requestDoc.exists) {
      throw new HttpsError("not-found", "Access request not found");
    }

    const data = requestDoc.data()!;
    if (data.status !== "pending") {
      throw new HttpsError("failed-precondition", "Request is not pending");
    }

    await requestRef.update({
      status: "dismissed",
      resolvedAt: FieldValue.serverTimestamp(),
      resolvedBy: request.auth.uid,
    });

    return { success: true };
  }
);
