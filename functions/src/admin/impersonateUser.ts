import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getAuth } from "firebase-admin/auth";

const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || "";

const FIREBASE_PROJECT_ID =
  process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "taxstudio-f12fb";
const CORS_ORIGINS = [
  process.env.APP_URL || "https://fibuki.com",
  `https://${FIREBASE_PROJECT_ID}.firebaseapp.com`,
  `https://${FIREBASE_PROJECT_ID}.web.app`,
  "http://localhost:3000",
];

interface ImpersonateRequest {
  targetUid: string;
}

interface ImpersonateResponse {
  token: string;
  targetUid: string;
  targetEmail: string | null;
  adminUid: string;
  adminEmail: string;
}

/**
 * Mint a Firebase custom token that signs the caller in as `targetUid`.
 *
 * Admin-only. Used for support/debugging — opens a side session in a separate
 * tab while the admin's own session in the main tab remains untouched.
 *
 * The minted token includes a `impersonatedBy` custom claim so we can both
 * audit-log impersonation and surface a banner in the target's session UI.
 */
export const impersonateUser = onCall<ImpersonateRequest, Promise<ImpersonateResponse>>(
  {
    region: "europe-west1",
    cors: CORS_ORIGINS,
  },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }

    const callerEmail = request.auth.token.email;
    const callerIsAdmin = request.auth.token.admin === true;
    if (!callerIsAdmin && callerEmail !== SUPER_ADMIN_EMAIL) {
      throw new HttpsError(
        "permission-denied",
        "Only admins can impersonate users",
      );
    }

    const { targetUid } = request.data;
    if (!targetUid || typeof targetUid !== "string") {
      throw new HttpsError("invalid-argument", "targetUid is required");
    }

    if (targetUid === request.auth.uid) {
      throw new HttpsError(
        "invalid-argument",
        "Cannot impersonate yourself",
      );
    }

    const auth = getAuth();
    let targetUser;
    try {
      targetUser = await auth.getUser(targetUid);
    } catch {
      throw new HttpsError("not-found", "Target user not found");
    }

    // Refuse to impersonate other admins (avoids privilege confusion).
    if (targetUser.customClaims?.admin === true) {
      throw new HttpsError(
        "permission-denied",
        "Cannot impersonate another admin",
      );
    }

    const token = await auth.createCustomToken(targetUid, {
      impersonatedBy: request.auth.uid,
      impersonatedByEmail: callerEmail ?? null,
    });

    console.log(
      `Admin ${callerEmail} (${request.auth.uid}) impersonating user ${targetUser.email} (${targetUid})`,
    );

    return {
      token,
      targetUid,
      targetEmail: targetUser.email ?? null,
      adminUid: request.auth.uid,
      adminEmail: callerEmail ?? "unknown",
    };
  },
);
