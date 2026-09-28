/**
 * Send invite notification email via the central mailer.
 *
 * Returns whether the mail was actually handed to the provider. The mailer
 * returns false instead of throwing when it is unconfigured or the send
 * fails, and swallowing that here is how invites sat "Pending" forever with
 * the UI reporting success (#159 finding 4) - callers that promise delivery
 * must check the return value.
 */

import { buildInviteSubject, buildInviteHtml, buildInviteText } from "./inviteEmail";
import { sendEmail } from "../utils/mailer";

export async function sendInviteEmail(email: string): Promise<boolean> {
  if (!email) {
    console.warn("[InviteEmail] No email provided");
    return false;
  }

  const sent = await sendEmail({
    to: email,
    subject: buildInviteSubject(),
    text: buildInviteText(),
    html: buildInviteHtml(),
  });

  if (sent) {
    console.log(`[InviteEmail] Sent invite to ${email}`);
  } else {
    console.warn(`[InviteEmail] Invite email to ${email} was NOT sent (mailer unconfigured or send failed)`);
  }
  return sent;
}
