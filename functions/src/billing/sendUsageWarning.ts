/**
 * Send AI budget warning emails via SendGrid.
 */

import { getFirestore } from "firebase-admin/firestore";

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

  if (!SENDGRID_API_KEY) {
    console.warn("[UsageWarning] SENDGRID_API_KEY not configured, skipping email");
    return;
  }

  const sgMail = (await import("@sendgrid/mail")).default;
  sgMail.setApiKey(SENDGRID_API_KEY);

  const subject =
    percent >= 100
      ? "AI budget exhausted — auto-matching paused"
      : "You've used 90% of your AI budget";

  const text =
    percent >= 100
      ? `Hi,\n\nYou've used ${usageEur.toFixed(2)} EUR of your ${limitEur.toFixed(2)} EUR AI budget this period.\n\nAuto-matching has been paused to prevent unexpected charges. Your files will continue to be extracted, but AI-powered partner lookup and agentic matching are on hold.\n\nTo resume:\n- Add AI credits at https://fibuki.com/settings/billing\n- Or upgrade your plan for a higher budget\n\nBest,\nFiBuKI`
      : `Hi,\n\nYou've used ${usageEur.toFixed(2)} EUR of your ${limitEur.toFixed(2)} EUR AI budget this period (90%).\n\nOnce you reach 100%, auto-matching will be paused.\n\nTo avoid interruptions:\n- Add AI credits at https://fibuki.com/settings/billing\n- Set an overage cap to allow spending beyond your limit\n- Or upgrade your plan for a higher budget\n\nBest,\nFiBuKI`;

  const html =
    percent >= 100
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
  const db = getFirestore();
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

  console.log(`[UsageWarning] Sent ${percent}% warning to ${email}`);
}
