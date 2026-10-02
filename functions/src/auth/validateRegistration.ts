import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { admitEmail, recordRegistration } from "./registrationGate";

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

    try {
      const decision = await admitEmail(db, normalizedEmail, SUPER_ADMIN_EMAIL, { rejectUsedInvite: true });
      if (decision.allowed) {
        const reasons = { "super-admin": "Super admin", invite: undefined, "open-seat": "Open seat claimed" };
        return { allowed: true, reason: reasons[decision.via] };
      }
      return {
        allowed: false,
        reason:
          decision.reason === "invite-used"
            ? "This invite has already been used."
            : "Email not found in invite list. Please request an invite from an admin.",
      };
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

    try {
      await recordRegistration(db, email, request.auth.uid, SUPER_ADMIN_EMAIL);
      return { success: true };
    } catch (error) {
      console.error("Error marking invite used:", error);
      throw new HttpsError("internal", "Failed to mark invite used");
    }
  }
);
