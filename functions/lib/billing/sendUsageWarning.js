"use strict";
/**
 * Send AI budget warning emails via SendGrid.
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
    if (!SENDGRID_API_KEY) {
        console.warn("[UsageWarning] SENDGRID_API_KEY not configured, skipping email");
        return;
    }
    const sgMail = (await Promise.resolve().then(() => __importStar(require("@sendgrid/mail")))).default;
    sgMail.setApiKey(SENDGRID_API_KEY);
    const subject = percent >= 100
        ? "AI budget exhausted — auto-matching paused"
        : "You've used 90% of your AI budget";
    const text = percent >= 100
        ? `Hi,\n\nYou've used ${usageEur.toFixed(2)} EUR of your ${limitEur.toFixed(2)} EUR AI budget this period.\n\nAuto-matching has been paused to prevent unexpected charges. Your files will continue to be extracted, but AI-powered partner lookup and agentic matching are on hold.\n\nTo resume:\n- Add AI credits at https://fibuki.com/settings/billing\n- Or upgrade your plan for a higher budget\n\nBest,\nFiBuKI`
        : `Hi,\n\nYou've used ${usageEur.toFixed(2)} EUR of your ${limitEur.toFixed(2)} EUR AI budget this period (90%).\n\nOnce you reach 100%, auto-matching will be paused.\n\nTo avoid interruptions:\n- Add AI credits at https://fibuki.com/settings/billing\n- Set an overage cap to allow spending beyond your limit\n- Or upgrade your plan for a higher budget\n\nBest,\nFiBuKI`;
    const html = percent >= 100
        ? `<p>Hi,</p>
<p>You've used <strong>${usageEur.toFixed(2)} EUR</strong> of your <strong>${limitEur.toFixed(2)} EUR</strong> AI budget this period.</p>
<p>Auto-matching has been <strong>paused</strong> to prevent unexpected charges. Your files will continue to be extracted, but AI-powered partner lookup and agentic matching are on hold.</p>
<p>To resume:</p>
<ul>
  <li><a href="https://fibuki.com/settings/billing">Add AI credits</a></li>
  <li>Or upgrade your plan for a higher budget</li>
</ul>
<p>Best,<br/>FiBuKI</p>`
        : `<p>Hi,</p>
<p>You've used <strong>${usageEur.toFixed(2)} EUR</strong> of your <strong>${limitEur.toFixed(2)} EUR</strong> AI budget this period (<strong>90%</strong>).</p>
<p>Once you reach 100%, auto-matching will be paused.</p>
<p>To avoid interruptions:</p>
<ul>
  <li><a href="https://fibuki.com/settings/billing">Add AI credits</a></li>
  <li>Set an overage cap to allow spending beyond your limit</li>
  <li>Or upgrade your plan for a higher budget</li>
</ul>
<p>Best,<br/>FiBuKI</p>`;
    await sgMail.send({
        to: email,
        from: { email: FROM_EMAIL, name: FROM_NAME },
        subject,
        text,
        html,
    });
    // Also create an in-app notification
    const db = (0, firestore_1.getFirestore)();
    await db.collection(`users/${userId}/notifications`).add({
        type: "billing_warning",
        title: subject,
        message: percent >= 100
            ? `AI budget exhausted (${usageEur.toFixed(2)}/${limitEur.toFixed(2)} EUR). Auto-matching paused.`
            : `90% of AI budget used (${usageEur.toFixed(2)}/${limitEur.toFixed(2)} EUR).`,
        createdAt: new Date(),
        readAt: null,
    });
    console.log(`[UsageWarning] Sent ${percent}% warning to ${email}`);
}
//# sourceMappingURL=sendUsageWarning.js.map