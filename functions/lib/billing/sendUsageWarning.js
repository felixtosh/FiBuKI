"use strict";
/**
 * Send AI budget warning emails via SendGrid.
 * Respects budgetWarningsEnabled preference — always creates in-app notification.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendUsageWarning = sendUsageWarning;
const firestore_1 = require("firebase-admin/firestore");
const budgetWarningEmail_1 = require("./budgetWarningEmail");
const unsubscribeTokens_1 = require("../emails/unsubscribeTokens");
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = "noreply@fibuki.com";
const FROM_NAME = "FiBuKI";
async function sendUsageWarning(userId, percent, usageEur, limitEur) {
    // Get user email from Firebase Auth
    const { getAuth } = await Promise.resolve().then(() => __importStar(require("firebase-admin/auth")));
    const user = await getAuth().getUser(userId);
    const email = user.email;
    if (!email) {
        console.warn(`[UsageWarning] No email for user ${userId}`);
        return;
    }
    const db = (0, firestore_1.getFirestore)();
    const subject = (0, budgetWarningEmail_1.buildBudgetWarningSubject)(percent);
    // Always create an in-app notification regardless of email preference
    await db.collection(`users/${userId}/notifications`).add({
        type: "billing_warning",
        title: subject,
        message: percent >= 100
            ? `AI budget exhausted (${usageEur.toFixed(2)}/${limitEur.toFixed(2)} EUR). Auto-matching paused.`
            : `90% of AI budget used (${usageEur.toFixed(2)}/${limitEur.toFixed(2)} EUR).`,
        createdAt: new Date(),
        readAt: null,
    });
    // Check email opt-out preference
    const subDoc = await db.collection("subscriptions").doc(userId).get();
    const subData = subDoc.data();
    if (subData?.budgetWarningsEnabled === false) {
        console.log(`[UsageWarning] User ${userId} has opted out of budget warning emails, skipping`);
        return;
    }
    if (!SENDGRID_API_KEY) {
        console.warn("[UsageWarning] SENDGRID_API_KEY not configured, skipping email");
        return;
    }
    const sgMail = (await Promise.resolve().then(() => __importStar(require("@sendgrid/mail")))).default;
    sgMail.setApiKey(SENDGRID_API_KEY);
    const name = user.displayName || undefined;
    const unsubscribeUrl = (0, unsubscribeTokens_1.buildUnsubscribeUrl)(userId, "budgetWarnings");
    const html = (0, budgetWarningEmail_1.buildBudgetWarningHtml)({ name, percent, usageEur, limitEur, unsubscribeUrl });
    const text = (0, budgetWarningEmail_1.buildBudgetWarningText)({ name, percent, usageEur, limitEur });
    await sgMail.send({
        to: email,
        from: { email: FROM_EMAIL, name: FROM_NAME },
        subject,
        text,
        html,
    });
    console.log(`[UsageWarning] Sent ${percent}% warning to ${email}`);
}
//# sourceMappingURL=sendUsageWarning.js.map