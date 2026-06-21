/**
 * Custom password reset email callable.
 * Uses generatePasswordResetLink() + Resend to send a branded email.
 * allowUnauthenticated: true — called from the login page.
 * Always returns { success: true } to prevent email enumeration.
 */

import { createCallable } from "../utils/createCallable";
import { defineSecret } from "firebase-functions/params";
import { getAuth } from "firebase-admin/auth";
import {
  buildPasswordResetSubject,
  buildPasswordResetHtml,
  buildPasswordResetText,
} from "./passwordResetEmail";

const resendApiKey = defineSecret("RESEND_API_KEY");
const FROM_EMAIL = "noreply@fibuki.com";
const FROM_NAME = "FiBuKI";

interface SendPasswordResetRequest {
  email: string;
}

interface SendPasswordResetResponse {
  success: boolean;
}

export const sendPasswordResetCallable = createCallable<
  SendPasswordResetRequest,
  SendPasswordResetResponse
>(
  { name: "sendPasswordReset", allowUnauthenticated: true, skipUsageLogging: true, secrets: [resendApiKey] },
  async (_ctx, request) => {
    const { email } = request;

    if (!email || !email.includes("@")) {
      // Don't reveal whether the email is valid
      return { success: true };
    }

    try {
      const resetLink = await getAuth().generatePasswordResetLink(email, {
        url: "https://fibuki.com/login",
      });

      const apiKey = resendApiKey.value();
      if (!apiKey) {
        console.warn("[sendPasswordReset] RESEND_API_KEY not configured");
        return { success: true };
      }

      // Try to get user display name for personalization
      let name: string | undefined;
      try {
        const user = await getAuth().getUserByEmail(email);
        name = user.displayName || undefined;
      } catch {
        // User might not exist — that's fine, we still don't reveal it
      }

      const { Resend } = await import("resend");
      const resend = new Resend(apiKey);

      await resend.emails.send({
        to: email,
        from: `${FROM_NAME} <${FROM_EMAIL}>`,
        subject: buildPasswordResetSubject(),
        html: buildPasswordResetHtml(resetLink, name),
        text: buildPasswordResetText(resetLink, name),
      });

      console.log(`[sendPasswordReset] Sent reset email to ${email}`);
    } catch (err) {
      // Log but don't expose errors to prevent enumeration
      console.error("[sendPasswordReset] Error:", err);
    }

    return { success: true };
  }
);
