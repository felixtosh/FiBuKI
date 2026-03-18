/**
 * Scheduled function to send weekly digest emails.
 * Runs Monday 9:00 CET (8:00 UTC).
 */

import { onSchedule } from "firebase-functions/v2/scheduler";
import { getFirestore } from "firebase-admin/firestore";
import { getAuth } from "firebase-admin/auth";
import { buildDigestSubject, buildDigestHtml, buildDigestText } from "./digestEmail";
import type { DigestStats } from "./digestEmail";
import { generateUnsubscribeToken } from "./unsubscribeDigest";

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = "noreply@fibuki.com";
const FROM_NAME = "FiBuKI";
const BATCH_SIZE = 10;
const UNSUBSCRIBE_BASE_URL =
  "https://europe-west1-taxstudio-a57fc.cloudfunctions.net/unsubscribeDigest";

export const sendWeeklyDigest = onSchedule(
  {
    schedule: "0 8 * * 1", // Monday 8:00 UTC = 9:00 CET
    region: "europe-west1",
    timeZone: "UTC",
    timeoutSeconds: 540,
    memory: "512MiB",
  },
  async () => {
    if (!SENDGRID_API_KEY) {
      console.warn("[WeeklyDigest] SENDGRID_API_KEY not configured, skipping");
      return;
    }

    const db = getFirestore();
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Get all subscriptions where digest is not explicitly disabled
    const subsSnapshot = await db
      .collection("subscriptions")
      .where("digestEnabled", "!=", false)
      .get();

    // Also include users without the digestEnabled field (opt-out model)
    const allSubsSnapshot = await db.collection("subscriptions").get();
    const optedOutIds = new Set(
      subsSnapshot.docs
        .filter((d) => d.data().digestEnabled === false)
        .map((d) => d.id)
    );

    const eligibleDocs = allSubsSnapshot.docs.filter(
      (d) => !optedOutIds.has(d.id)
    );

    console.log(`[WeeklyDigest] Processing ${eligibleDocs.length} users`);

    const sgMail = (await import("@sendgrid/mail")).default;
    sgMail.setApiKey(SENDGRID_API_KEY);

    let sent = 0;
    let skipped = 0;

    // Process in batches
    for (let i = 0; i < eligibleDocs.length; i += BATCH_SIZE) {
      const batch = eligibleDocs.slice(i, i + BATCH_SIZE);

      await Promise.all(
        batch.map(async (subDoc) => {
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
            const user = await getAuth().getUser(userId);
            if (!user.email) {
              skipped++;
              return;
            }

            // Generate unsubscribe URL
            const token = generateUnsubscribeToken(userId);
            const unsubscribeUrl = `${UNSUBSCRIBE_BASE_URL}?uid=${userId}&token=${token}`;

            const subject = buildDigestSubject(stats);
            const html = buildDigestHtml(stats, unsubscribeUrl);
            const text = buildDigestText(stats, unsubscribeUrl);

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
          } catch (err) {
            console.error(`[WeeklyDigest] Failed for user=${userId}:`, err);
          }
        })
      );
    }

    console.log(`[WeeklyDigest] Done: sent=${sent} skipped=${skipped}`);
  }
);

async function gatherUserStats(
  db: FirebaseFirestore.Firestore,
  userId: string,
  since: Date
): Promise<DigestStats> {
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
