/**
 * Send invite notification email via Resend.
 */

import { buildInviteSubject, buildInviteHtml, buildInviteText } from "./inviteEmail";

const FROM_EMAIL = "noreply@fibuki.com";
const FROM_NAME = "FiBuKI";

export async function sendInviteEmail(email: string): Promise<void> {
  if (!email) {
    console.warn("[InviteEmail] No email provided");
    return;
  }

  const apiKey = process.env.RESEND_API_KEY || "";
  if (!apiKey) {
    console.warn("[InviteEmail] RESEND_API_KEY not configured, skipping email");
    return;
  }

  const { Resend } = await import("resend");
  const resend = new Resend(apiKey);

  await resend.emails.send({
    to: email,
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    subject: buildInviteSubject(),
    text: buildInviteText(),
    html: buildInviteHtml(),
  });

  console.log(`[InviteEmail] Sent invite to ${email}`);
}
