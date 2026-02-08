/**
 * Admin User Management Functions
 *
 * listAllUsers — list all users with subscription data
 * setUserOverride — admin sets free_plan or plan_tester override
 * switchTesterPlan — plan testers switch their own plan
 */

import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";
import { PLANS, createDefaultSubscriptionData } from "../billing/config";
import type { PlanId, AdminOverride } from "../billing/config";

const SUPER_ADMIN_EMAIL = "felix@i7v6.com";

const CORS_ORIGINS = [
  "https://fibuki.com",
  "https://taxstudio-f12fb.firebaseapp.com",
  "https://taxstudio-f12fb.web.app",
  "http://localhost:3000",
];

function assertAdmin(request: { auth?: { token: { email?: string; admin?: boolean } } }) {
  if (!request.auth) {
    throw new HttpsError("unauthenticated", "Must be logged in");
  }
  const callerIsAdmin = request.auth.token.admin === true;
  const callerEmail = request.auth.token.email;
  if (!callerIsAdmin && callerEmail !== SUPER_ADMIN_EMAIL) {
    throw new HttpsError("permission-denied", "Admin access required");
  }
}

// =============================================================================
// listAllUsers
// =============================================================================

export const listAllUsers = onCall(
  { region: "europe-west1", cors: CORS_ORIGINS },
  async (request) => {
    assertAdmin(request);

    const auth = getAuth();
    const db = getFirestore();

    const listResult = await auth.listUsers(1000);
    const uids = listResult.users.map((u) => u.uid);

    // Batch-read subscriptions (Firestore getAll supports up to 500 refs at once)
    const subRefs = uids.map((uid) => db.collection("subscriptions").doc(uid));
    const subDocs = subRefs.length > 0 ? await db.getAll(...subRefs) : [];
    const subMap = new Map<string, FirebaseFirestore.DocumentData>();
    for (const doc of subDocs) {
      if (doc.exists) {
        subMap.set(doc.id, doc.data()!);
      }
    }

    const users = listResult.users.map((user) => {
      const sub = subMap.get(user.uid);
      return {
        uid: user.uid,
        email: user.email || null,
        displayName: user.displayName || null,
        isAdmin: user.customClaims?.admin === true,
        isSuperAdmin: user.email === SUPER_ADMIN_EMAIL,
        plan: (sub?.plan as PlanId) || "free",
        adminOverride: (sub?.adminOverride as AdminOverride) || null,
        stripeSubscriptionStatus: sub?.stripeSubscriptionStatus || "none",
        transactionCount: sub?.transactionCountCurrentMonth || 0,
        createdAt: user.metadata.creationTime || null,
      };
    });

    return { users };
  }
);

// =============================================================================
// setUserOverride
// =============================================================================

interface SetUserOverrideRequest {
  targetUid: string;
  override: "free_plan" | "plan_tester" | null;
  plan?: PlanId;
}

export const setUserOverride = onCall(
  { region: "europe-west1", cors: CORS_ORIGINS },
  async (request) => {
    assertAdmin(request);

    const { targetUid, override, plan } = request.data as SetUserOverrideRequest;
    if (!targetUid) {
      throw new HttpsError("invalid-argument", "targetUid is required");
    }

    const db = getFirestore();
    const subRef = db.collection("subscriptions").doc(targetUid);
    const subDoc = await subRef.get();

    const callerEmail = request.auth!.token.email || "unknown";
    const now = FieldValue.serverTimestamp();

    if (override === "free_plan") {
      const data = subDoc.exists
        ? {
            plan: "pro" as const,
            stripeSubscriptionStatus: "active" as const,
            aiFairUseLimitEur: PLANS.pro.aiFairUseLimitEur,
            adminOverride: "free_plan" as const,
            adminOverrideSetBy: callerEmail,
            adminOverrideSetAt: now,
            updatedAt: now,
          }
        : {
            ...createDefaultSubscriptionData(targetUid),
            plan: "pro" as const,
            stripeSubscriptionStatus: "active" as const,
            aiFairUseLimitEur: PLANS.pro.aiFairUseLimitEur,
            adminOverride: "free_plan" as const,
            adminOverrideSetBy: callerEmail,
            adminOverrideSetAt: now,
          };

      await subRef.set(data, { merge: true });
      console.log(`[UserMgmt] Set free_plan override for ${targetUid} by ${callerEmail}`);
      return { success: true, override: "free_plan" };
    }

    if (override === "plan_tester") {
      const targetPlan = plan || "free";
      const planConfig = PLANS[targetPlan] || PLANS.free;

      const data = subDoc.exists
        ? {
            plan: targetPlan,
            stripeSubscriptionStatus: "active" as const,
            aiFairUseLimitEur: planConfig.aiFairUseLimitEur,
            adminOverride: "plan_tester" as const,
            adminOverrideSetBy: callerEmail,
            adminOverrideSetAt: now,
            updatedAt: now,
          }
        : {
            ...createDefaultSubscriptionData(targetUid),
            plan: targetPlan,
            stripeSubscriptionStatus: "active" as const,
            aiFairUseLimitEur: planConfig.aiFairUseLimitEur,
            adminOverride: "plan_tester" as const,
            adminOverrideSetBy: callerEmail,
            adminOverrideSetAt: now,
          };

      await subRef.set(data, { merge: true });
      console.log(`[UserMgmt] Set plan_tester override (${targetPlan}) for ${targetUid} by ${callerEmail}`);
      return { success: true, override: "plan_tester", plan: targetPlan };
    }

    // Clear override (override === null)
    if (!subDoc.exists) {
      return { success: true, override: null };
    }

    await subRef.update({
      plan: "free",
      stripeSubscriptionStatus: "none",
      aiFairUseLimitEur: PLANS.free.aiFairUseLimitEur,
      stripeCustomerId: null,
      stripeSubscriptionId: null,
      adminOverride: FieldValue.delete(),
      adminOverrideSetBy: FieldValue.delete(),
      adminOverrideSetAt: FieldValue.delete(),
      updatedAt: now,
    });

    console.log(`[UserMgmt] Cleared override for ${targetUid} by ${callerEmail}`);
    return { success: true, override: null };
  }
);

// =============================================================================
// switchTesterPlan
// =============================================================================

interface SwitchTesterPlanRequest {
  plan: PlanId;
}

export const switchTesterPlan = onCall(
  { region: "europe-west1", cors: CORS_ORIGINS },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Must be logged in");
    }

    const userId = request.auth.uid;
    const { plan } = request.data as SwitchTesterPlanRequest;

    if (!plan || !PLANS[plan]) {
      throw new HttpsError("invalid-argument", "Valid plan is required");
    }

    const db = getFirestore();
    const subRef = db.collection("subscriptions").doc(userId);
    const subDoc = await subRef.get();

    if (!subDoc.exists || subDoc.data()?.adminOverride !== "plan_tester") {
      throw new HttpsError("permission-denied", "Only plan testers can switch plans");
    }

    const planConfig = PLANS[plan];

    await subRef.update({
      plan,
      aiFairUseLimitEur: planConfig.aiFairUseLimitEur,
      // Reset AI counters only — preserve transaction count so existing
      // transactions aren't retroactively affected on downgrades
      aiUsageCurrentPeriodEur: 0,
      aiOverageCurrentPeriodEur: 0,
      aiPaused: false,
      aiWarning90Sent: false,
      aiWarning100Sent: false,
      updatedAt: FieldValue.serverTimestamp(),
    });

    console.log(`[UserMgmt] Plan tester ${userId} switched to ${plan}`);
    return { success: true, plan };
  }
);
