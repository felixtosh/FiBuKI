/**
 * Send AI budget warning emails via SendGrid.
 * Respects budgetWarningsEnabled preference — always creates in-app notification.
 */

import { getFirestore } from "firebase-admin/firestore";
import {
  buildBudgetWarningSubject,
  buildBudgetWarningHtml,
  buildBudgetWarningText,
} from "./budgetWarningEmail";
import { buildUnsubscribeUrl } from "../emails/unsubscribeTokens";

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = "noreply@fibuki.com";
const FROM_NAME = "FiBuKI";

export async function sendUsageWarning(
  userId: string,
  percent: number,
  usageEur: number,
  limitEur: number
): Promise<void> {
  // Get user email from Firebase Auth
  const { getAuth } = await import("firebase-admin/auth");
  const user = await getAuth().getUser(userId);
  const email = user.email;

  if (!email) {
    console.warn(`[UsageWarning] No email for user ${userId}`);
    return;
  }

  const db = getFirestore();
  const subject = buildBudgetWarningSubject(percent);

  // Always create an in-app notification regardless of email preference
  await db.collection(`users/${userId}/notifications`).add({
    type: "billing_warning",
    title: subject,
    message:
      percent >= 100
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

  const sgMail = (await import("@sendgrid/mail")).default;
  sgMail.setApiKey(SENDGRID_API_KEY);

  const name = user.displayName || undefined;
  const unsubscribeUrl = buildUnsubscribeUrl(userId, "budgetWarnings");
  const html = buildBudgetWarningHtml({ name, percent, usageEur, limitEur, unsubscribeUrl });
  const text = buildBudgetWarningText({ name, percent, usageEur, limitEur });

  await sgMail.send({
    to: email,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject,
    text,
    html,
  });

  console.log(`[UsageWarning] Sent ${percent}% warning to ${email}`);
}
