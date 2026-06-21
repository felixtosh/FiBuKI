import { createCallable, HttpsError } from "../utils/createCallable";
import { defineSecret } from "firebase-functions/params";
import { sendInviteEmail } from "./sendInviteEmail";

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

    await sendInviteEmail(email.toLowerCase().trim());

    return { success: true };
  }
);
