"use strict";
/**
 * Admin User Management Functions
 *
 * listAllUsers — list all users with subscription data
 * setUserOverride — admin sets free_plan or plan_tester override
 * switchTesterPlan — plan testers switch their own plan
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.switchTesterPlan = exports.setUserOverride = exports.listAllUsers = void 0;
const https_1 = require("firebase-functions/v2/https");
const auth_1 = require("firebase-admin/auth");
const firestore_1 = require("firebase-admin/firestore");
const config_1 = require("../billing/config");
const SUPER_ADMIN_EMAIL = "felix@i7v6.com";
const CORS_ORIGINS = [
    "https://fibuki.com",
    "https://taxstudio-f12fb.firebaseapp.com",
    "https://taxstudio-f12fb.web.app",
    "http://localhost:3000",
];
function assertAdmin(request) {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "Must be logged in");
    }
    const callerIsAdmin = request.auth.token.admin === true;
    const callerEmail = request.auth.token.email;
    if (!callerIsAdmin && callerEmail !== SUPER_ADMIN_EMAIL) {
        throw new https_1.HttpsError("permission-denied", "Admin access required");
    }
}
// =============================================================================
// listAllUsers
// =============================================================================
exports.listAllUsers = (0, https_1.onCall)({ region: "europe-west1", cors: CORS_ORIGINS }, async (request) => {
    assertAdmin(request);
    const auth = (0, auth_1.getAuth)();
    const db = (0, firestore_1.getFirestore)();
    const listResult = await auth.listUsers(1000);
    const uids = listResult.users.map((u) => u.uid);
    // Batch-read subscriptions (Firestore getAll supports up to 500 refs at once)
    const subRefs = uids.map((uid) => db.collection("subscriptions").doc(uid));
    const subDocs = subRefs.length > 0 ? await db.getAll(...subRefs) : [];
    const subMap = new Map();
    for (const doc of subDocs) {
        if (doc.exists) {
            subMap.set(doc.id, doc.data());
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
            plan: sub?.plan || "free",
            adminOverride: sub?.adminOverride || null,
            stripeSubscriptionStatus: sub?.stripeSubscriptionStatus || "none",
            transactionCount: sub?.transactionCountCurrentMonth || 0,
            createdAt: user.metadata.creationTime || null,
        };
    });
    return { users };
});
exports.setUserOverride = (0, https_1.onCall)({ region: "europe-west1", cors: CORS_ORIGINS }, async (request) => {
    assertAdmin(request);
    const { targetUid, override, plan } = request.data;
    if (!targetUid) {
        throw new https_1.HttpsError("invalid-argument", "targetUid is required");
    }
    const db = (0, firestore_1.getFirestore)();
    const subRef = db.collection("subscriptions").doc(targetUid);
    const subDoc = await subRef.get();
    const callerEmail = request.auth.token.email || "unknown";
    const now = firestore_1.FieldValue.serverTimestamp();
    if (override === "free_plan") {
        const data = subDoc.exists
            ? {
                plan: "pro",
                stripeSubscriptionStatus: "active",
                aiFairUseLimitEur: config_1.PLANS.pro.aiFairUseLimitEur,
                adminOverride: "free_plan",
                adminOverrideSetBy: callerEmail,
                adminOverrideSetAt: now,
                updatedAt: now,
            }
            : {
                ...(0, config_1.createDefaultSubscriptionData)(targetUid),
                plan: "pro",
                stripeSubscriptionStatus: "active",
                aiFairUseLimitEur: config_1.PLANS.pro.aiFairUseLimitEur,
                adminOverride: "free_plan",
                adminOverrideSetBy: callerEmail,
                adminOverrideSetAt: now,
            };
        await subRef.set(data, { merge: true });
        console.log(`[UserMgmt] Set free_plan override for ${targetUid} by ${callerEmail}`);
        return { success: true, override: "free_plan" };
    }
    if (override === "plan_tester") {
        const targetPlan = plan || "starter";
        const planConfig = config_1.PLANS[targetPlan] || config_1.PLANS.starter;
        const data = subDoc.exists
            ? {
                plan: targetPlan,
                stripeSubscriptionStatus: "active",
                aiFairUseLimitEur: planConfig.aiFairUseLimitEur,
                adminOverride: "plan_tester",
                adminOverrideSetBy: callerEmail,
                adminOverrideSetAt: now,
                updatedAt: now,
            }
            : {
                ...(0, config_1.createDefaultSubscriptionData)(targetUid),
                plan: targetPlan,
                stripeSubscriptionStatus: "active",
                aiFairUseLimitEur: planConfig.aiFairUseLimitEur,
                adminOverride: "plan_tester",
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
        aiFairUseLimitEur: config_1.PLANS.free.aiFairUseLimitEur,
        stripeCustomerId: null,
        stripeSubscriptionId: null,
        adminOverride: firestore_1.FieldValue.delete(),
        adminOverrideSetBy: firestore_1.FieldValue.delete(),
        adminOverrideSetAt: firestore_1.FieldValue.delete(),
        updatedAt: now,
    });
    console.log(`[UserMgmt] Cleared override for ${targetUid} by ${callerEmail}`);
    return { success: true, override: null };
});
exports.switchTesterPlan = (0, https_1.onCall)({ region: "europe-west1", cors: CORS_ORIGINS }, async (request) => {
    if (!request.auth) {
        throw new https_1.HttpsError("unauthenticated", "Must be logged in");
    }
    const userId = request.auth.uid;
    const { plan } = request.data;
    if (!plan || !config_1.PLANS[plan]) {
        throw new https_1.HttpsError("invalid-argument", "Valid plan is required");
    }
    const db = (0, firestore_1.getFirestore)();
    const subRef = db.collection("subscriptions").doc(userId);
    const subDoc = await subRef.get();
    if (!subDoc.exists || subDoc.data()?.adminOverride !== "plan_tester") {
        throw new https_1.HttpsError("permission-denied", "Only plan testers can switch plans");
    }
    const planConfig = config_1.PLANS[plan];
    const now = new Date();
    const yearMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    await subRef.update({
        plan,
        aiFairUseLimitEur: planConfig.aiFairUseLimitEur,
        // Reset usage counters for clean testing
        aiUsageCurrentPeriodEur: 0,
        aiOverageCurrentPeriodEur: 0,
        aiPaused: false,
        aiWarning90Sent: false,
        aiWarning100Sent: false,
        transactionCountCurrentMonth: 0,
        transactionCountMonth: yearMonth,
        updatedAt: firestore_1.FieldValue.serverTimestamp(),
    });
    console.log(`[UserMgmt] Plan tester ${userId} switched to ${plan}`);
    return { success: true, plan };
});
//# sourceMappingURL=userManagement.js.map