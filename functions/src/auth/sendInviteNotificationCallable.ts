import { createCallable, HttpsError } from "../utils/createCallable";
import { defineSecret } from "firebase-functions/params";
import { sendInviteEmail } from "./sendInviteEmail";
import { isMailerConfigured } from "../utils/mailer";

const resendApiKey = defineSecret("RESEND_API_KEY");

interface SendInviteNotificationRequest {
  email: string;
}

interface SendInviteNotificationResponse {
  success: boolean;
}

export const sendInviteNotificationCallable = createCallable<
  SendInviteNotificationRequest,
  SendInviteNotificationResponse
>(
  { name: "sendInviteNotification", secrets: [resendApiKey] },
  async (ctx, request) => {
    // Admin only
    if (!ctx.request.auth?.token.admin) {
      throw new HttpsError("permission-denied", "Admin only");
    }

    const { email } = request;

    if (!email || typeof email !== "string") {
      throw new HttpsError("invalid-argument", "email is required");
    }

    // #159 finding 4: an unconfigured mailer used to log "skipping email" and
    // this callable still answered success - the invite sat Pending forever.
    // Fail loudly instead, naming what to configure.
    if (!isMailerConfigured()) {
      throw new HttpsError(
        "failed-precondition",
        "No mailer is configured, so the invite email cannot be sent. " +
          "Configure SMTP (FIBUKI_SMTP_HOST/USER/PASS) on self-host, or the email provider key on cloud, " +
          "or share the sign-up link with the invitee yourself."
      );
    }

    const sent = await sendInviteEmail(email.toLowerCase().trim());
    if (!sent) {
      throw new HttpsError(
        "unavailable",
        "The invite email was not sent - the mailer reported a send failure. Check the server logs."
      );
    }

    return { success: true };
  }
);
