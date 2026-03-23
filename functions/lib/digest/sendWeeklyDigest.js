"use strict";
/**
 * Scheduled function to send weekly digest emails.
 * Runs Monday 9:00 CET (8:00 UTC).
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
exports.sendWeeklyDigest = void 0;
const scheduler_1 = require("firebase-functions/v2/scheduler");
const firestore_1 = require("firebase-admin/firestore");
const auth_1 = require("firebase-admin/auth");
const digestEmail_1 = require("./digestEmail");
const unsubscribeDigest_1 = require("./unsubscribeDigest");
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = "noreply@fibuki.com";
const FROM_NAME = "FiBuKI";
const BATCH_SIZE = 10;
const UNSUBSCRIBE_BASE_URL = "https://europe-west1-taxstudio-f12fb.cloudfunctions.net/unsubscribeDigest";
exports.sendWeeklyDigest = (0, scheduler_1.onSchedule)({
    schedule: "0 8 * * 1", // Monday 8:00 UTC = 9:00 CET
    region: "europe-west1",
    timeZone: "UTC",
    timeoutSeconds: 540,
    memory: "512MiB",
}, async () => {
    if (!SENDGRID_API_KEY) {
        console.warn("[WeeklyDigest] SENDGRID_API_KEY not configured, skipping");
        return;
    }
    const db = (0, firestore_1.getFirestore)();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    // Get all subscriptions where digest is not explicitly disabled
    const subsSnapshot = await db
        .collection("subscriptions")
        .where("digestEnabled", "!=", false)
        .get();
    // Also include users without the digestEnabled field (opt-out model)
    const allSubsSnapshot = await db.collection("subscriptions").get();
    const optedOutIds = new Set(subsSnapshot.docs
        .filter((d) => d.data().digestEnabled === false)
        .map((d) => d.id));
    const eligibleDocs = allSubsSnapshot.docs.filter((d) => !optedOutIds.has(d.id));
    console.log(`[WeeklyDigest] Processing ${eligibleDocs.length} users`);
    const sgMail = (await Promise.resolve().then(() => __importStar(require("@sendgrid/mail")))).default;
    sgMail.setApiKey(SENDGRID_API_KEY);
    let sent = 0;
    let skipped = 0;
    // Process in batches
    for (let i = 0; i < eligibleDocs.length; i += BATCH_SIZE) {
        const batch = eligibleDocs.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (subDoc) => {
            const userId = subDoc.id;
            try {
                // Gather stats for the last 7 days
                const stats = await gatherUserStats(db, userId, sevenDaysAgo);
                // Skip inactive users (no new transactions)
                if (stats.newTransactions === 0) {
                    skipped++;
                    return;
                }
                // Get user email
                const user = await (0, auth_1.getAuth)().getUser(userId);
                if (!user.email) {
                    skipped++;
                    return;
                }
                // Generate unsubscribe URL
                const token = (0, unsubscribeDigest_1.generateUnsubscribeToken)(userId);
                const unsubscribeUrl = `${UNSUBSCRIBE_BASE_URL}?uid=${userId}&token=${token}`;
                const name = user.displayName || undefined;
                const subject = (0, digestEmail_1.buildDigestSubject)(stats);
                const html = (0, digestEmail_1.buildDigestHtml)(stats, unsubscribeUrl, name);
                const text = (0, digestEmail_1.buildDigestText)(stats, unsubscribeUrl, name);
                await sgMail.send({
                    to: user.email,
                    from: { email: FROM_EMAIL, name: FROM_NAME },
                    subject,
                    html,
                    text,
                    headers: {
                        "List-Unsubscribe": `<${unsubscribeUrl}>`,
                        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
                    },
                });
                sent++;
            }
            catch (err) {
                console.error(`[WeeklyDigest] Failed for user=${userId}:`, err);
            }
        }));
    }
    console.log(`[WeeklyDigest] Done: sent=${sent} skipped=${skipped}`);
});
async function gatherUserStats(db, userId, since) {
    // New transactions in the last 7 days
    const txQuery = await db
        .collection("transactions")
        .where("userId", "==", userId)
        .where("createdAt", ">=", since)
        .get();
    const newTransactions = txQuery.size;
    // Count unmatched (no files, no noReceiptCategoryId)
    let unmatchedTransactions = 0;
    for (const doc of txQuery.docs) {
        const data = doc.data();
        const hasFiles = data.fileIds && data.fileIds.length > 0;
        const hasNoReceipt = !!data.noReceiptCategoryId;
        if (!hasFiles && !hasNoReceipt) {
            unmatchedTransactions++;
        }
    }
    // Completion rate (of ALL user transactions, not just new)
    const allTxQuery = await db
        .collection("transactions")
        .where("userId", "==", userId)
        .where("isComplete", "==", true)
        .count()
        .get();
    const allTxTotal = await db
        .collection("transactions")
        .where("userId", "==", userId)
        .count()
        .get();
    const totalTx = allTxTotal.data().count;
    const completeTx = allTxQuery.data().count;
    const completionRate = totalTx > 0 ? Math.round((completeTx / totalTx) * 100) : 0;
    // New files uploaded
    const filesQuery = await db
        .collection("files")
        .where("userId", "==", userId)
        .where("createdAt", ">=", since)
        .get();
    return {
        newTransactions,
        unmatchedTransactions,
        completionRate,
        newFiles: filesQuery.size,
    };
}
//# sourceMappingURL=sendWeeklyDigest.js.map