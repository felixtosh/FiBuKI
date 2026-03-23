import { onCall, HttpsError } from "firebase-functions/v2/https";
import { beforeUserCreated } from "firebase-functions/v2/identity";
import { getAuth } from "firebase-admin/auth";

const SUPER_ADMIN_EMAIL = process.env.SUPER_ADMIN_EMAIL || "";

const FIREBASE_PROJECT_ID = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "taxstudio-f12fb";
const CORS_ORIGINS = [
  process.env.APP_URL || "https://fibuki.com",
  `https://${FIREBASE_PROJECT_ID}.firebaseapp.com`,
  `https://${FIREBASE_PROJECT_ID}.web.app`,
  "http://localhost:3000",
];

/**
 * Callable function to set admin claim on a user
 * Only callable by existing admins or the super admin
 */
export const setAdminClaim = onCall(
  {
    region: "europe-west1",
    cors: CORS_ORIGINS,
  },
  async (request) => {
    const { targetUid, isAdmin } = request.data;

    // Verify caller is authenticated
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }

    // Verify caller is admin or super admin
    const callerEmail = request.auth.token.email;
    const callerIsAdmin = request.auth.token.admin === true;

    if (!callerIsAdmin && callerEmail !== SUPER_ADMIN_EMAIL) {
      throw new HttpsError(
        "permission-denied",
        "Only admins can modify admin claims"
      );
    }

    if (!targetUid || typeof isAdmin !== "boolean") {
      throw new HttpsError(
        "invalid-argument",
        "targetUid and isAdmin are required"
      );
    }

    try {
      const auth = getAuth();
      await auth.setCustomUserClaims(targetUid, { admin: isAdmin });

      // Get the user to return their email
      const targetUser = await auth.getUser(targetUid);

      console.log(
        `Admin claim set to ${isAdmin} for user ${targetUser.email} by ${callerEmail}`
      );

      return {
        success: true,
        targetEmail: targetUser.email,
        isAdmin,
      };
    } catch (error) {
      console.error("Error setting admin claim:", error);
      throw new HttpsError("internal", "Failed to set admin claim");
    }
  }
);

/**
 * Blocking function that runs before user creation
 * Auto-sets admin claim for super admin
 */
export const beforeUserCreatedHandler = beforeUserCreated(
  {
    region: "europe-west1",
  },
  async (event) => {
    const user = event.data;

    // Auto-set admin for super admin email
    if (user?.email === SUPER_ADMIN_EMAIL) {
      console.log(`Setting admin claim for super admin: ${user.email}`);
      return {
        customClaims: {
          admin: true,
        },
      };
    }

    return {};
  }
);

/**
 * Get list of all admin users
 * Only callable by admins
 */
export const listAdmins = onCall(
  {
    region: "europe-west1",
    cors: CORS_ORIGINS,
  },
  async (request) => {
    // Verify caller is admin
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }

    const callerEmail = request.auth.token.email;
    const callerIsAdmin = request.auth.token.admin === true;

    if (!callerIsAdmin && callerEmail !== SUPER_ADMIN_EMAIL) {
      throw new HttpsError("permission-denied", "Only admins can list admins");
    }

    try {
      const auth = getAuth();
      const listResult = await auth.listUsers(1000);

      const admins = listResult.users
        .filter((user) => user.customClaims?.admin === true)
        .map((user) => ({
          uid: user.uid,
          email: user.email,
          displayName: user.displayName,
          isSuperAdmin: user.email === SUPER_ADMIN_EMAIL,
        }));

      return { admins };
    } catch (error) {
      console.error("Error listing admins:", error);
      throw new HttpsError("internal", "Failed to list admins");
    }
  }
);
