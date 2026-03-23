import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const db = getFirestore();
const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || "";

const FIREBASE_PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "taxstudio-f12fb";
const CORS_ORIGINS = [
  process.env.APP_URL || "https://fibuki.com",
  `https://${FIREBASE_PROJECT_ID}.firebaseapp.com`,
  `https://${FIREBASE_PROJECT_ID}.web.app`,
  "http://localhost:3000",
];

/**
 * Callable function to check if an email is allowed to register
 * This is called BEFORE createUserWithEmailAndPassword
 *
 * Returns { allowed: boolean, reason?: string }
 */
export const validateRegistration = onCall(
  {
    region: "europe-west1",
    cors: CORS_ORIGINS,
  },
  async (request) => {
    const { email } = request.data;

    if (!email || typeof email !== "string") {
      throw new HttpsError("invalid-argument", "Email is required");
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Super admin is always allowed
    if (normalizedEmail === SUPER_ADMIN_EMAIL) {
      return { allowed: true, reason: "Super admin" };
    }

    try {
      // Check allowedEmails collection
      const allowedQuery = await db
        .collection("allowedEmails")
        .where("email", "==", normalizedEmail)
        .limit(1)
        .get();

      if (allowedQuery.empty) {
        // Check open seats — atomically claim one if available
        const configRef = db.collection("config").doc("openSeats");
        const seatClaimed = await db.runTransaction(async (tx) => {
          const configDoc = await tx.get(configRef);
          if (!configDoc.exists) return false;

          const data = configDoc.data()!;
          const remaining = data.remainingSeats as number;
          if (remaining <= 0) return false;

          // Decrement remaining seats
          tx.update(configRef, { remainingSeats: remaining - 1 });

          // Create allowedEmails doc so the user is permanently allowed
          const allowedRef = db.collection("allowedEmails").doc();
          tx.set(allowedRef, {
            email: normalizedEmail,
            addedBy: "open-seat",
            addedAt: new Date(),
          });

          return true;
        });

        if (seatClaimed) {
          return { allowed: true, reason: "Open seat claimed" };
        }

        return {
          allowed: false,
          reason: "Email not found in invite list. Please request an invite from an admin.",
        };
      }

      const inviteDoc = allowedQuery.docs[0];
      const inviteData = inviteDoc.data();

      // Check if already used
      if (inviteData.usedAt) {
        return {
          allowed: false,
          reason: "This invite has already been used.",
        };
      }

      return { allowed: true };
    } catch (error) {
      console.error("Error validating registration:", error);
      throw new HttpsError("internal", "Failed to validate registration");
    }
  }
);

/**
 * Mark an invite as used after successful registration
 * Called after user creation
 */
export const markInviteUsed = onCall(
  {
    region: "europe-west1",
    cors: CORS_ORIGINS,
  },
  async (request) => {
    // This should only be called by authenticated users (just registered)
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }

    const email = request.auth.token.email;
    if (!email) {
      throw new HttpsError("invalid-argument", "User has no email");
    }

    const normalizedEmail = email.toLowerCase().trim();

    // Super admin doesn't have an invite to mark
    if (normalizedEmail === SUPER_ADMIN_EMAIL) {
      return { success: true };
    }

    try {
      const allowedQuery = await db
        .collection("allowedEmails")
        .where("email", "==", normalizedEmail)
        .limit(1)
        .get();

      if (!allowedQuery.empty) {
        const inviteDoc = allowedQuery.docs[0];
        await inviteDoc.ref.update({
          usedAt: new Date(),
          registeredUserId: request.auth.uid,
        });
      }

      // Increment cumulative claimed seats counter
      const configRef = db.collection("config").doc("openSeats");
      await configRef.set(
        { claimedSeats: FieldValue.increment(1) },
        { merge: true }
      );

      return { success: true };
    } catch (error) {
      console.error("Error marking invite used:", error);
      throw new HttpsError("internal", "Failed to mark invite used");
    }
  }
);
