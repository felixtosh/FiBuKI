/**
 * Admin-only callable to send a test email to a given recipient.
 */

import { createCallable, HttpsError } from "../utils/createCallable";
import {
  buildDigestSubject,
  buildDigestHtml,
  buildDigestText,
} from "../digest/digestEmail";
import {
  buildInviteSubject,
  buildInviteHtml,
  buildInviteText,
} from "./inviteEmail";
import {
  buildBudgetWarningSubject,
  buildBudgetWarningHtml,
  buildBudgetWarningText,
} from "../billing/budgetWarningEmail";
import {
  buildPasswordResetSubject,
  buildPasswordResetHtml,
  buildPasswordResetText,
} from "./passwordResetEmail";
import { resolveMergeFields } from "../emails/resolveMergeFields";

type EmailTemplate = "digest" | "budget_warning_90" | "budget_warning_100" | "invite" | "password_reset";

interface SendTestEmailRequest {
  template: EmailTemplate;
  recipientEmail: string;
  mergeFieldsEmail?: string;
}

interface SendTestEmailResponse {
  success: boolean;
}

const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = "noreply@fibuki.com";
const FROM_NAME = "FiBuKI";

export const sendTestEmailCallable = createCallable<
  SendTestEmailRequest,
  SendTestEmailResponse
>(
  { name: "sendTestEmail" },
  async (ctx, request) => {
    if (!ctx.request.auth?.token.admin) {
      throw new HttpsError("permission-denied", "Admin only");
    }

    const { template, recipientEmail, mergeFieldsEmail } = request;

    if (!recipientEmail || !recipientEmail.includes("@")) {
      throw new HttpsError("invalid-argument", "Valid recipientEmail is required");
    }

    if (!SENDGRID_API_KEY) {
      throw new HttpsError("failed-precondition", "SENDGRID_API_KEY not configured");
    }

    const fields = await resolveMergeFields(ctx.db, template, mergeFieldsEmail);
    let subject: string;
    let html: string;
    let text: string;

    switch (template) {
      case "digest": {
        const stats = {
          newTransactions: fields.newTransactions ?? 42,
          unmatchedTransactions: fields.unmatchedTransactions ?? 7,
          completionRate: fields.completionRate ?? 83,
          newFiles: fields.newFiles ?? 12,
        };
        const unsubscribeUrl = "https://fibuki.com/api/digest/unsubscribe?token=test";
        subject = `[TEST] ${buildDigestSubject(stats)}`;
        html = buildDigestHtml(stats, unsubscribeUrl, fields.name);
        text = buildDigestText(stats, unsubscribeUrl, fields.name);
        break;
      }

      case "budget_warning_90": {
        const data = {
          name: fields.name,
          percent: 90,
          usageEur: fields.usageEur ?? 4.5,
          limitEur: fields.limitEur ?? 5.0,
          unsubscribeUrl: "https://fibuki.com/api/budget/unsubscribe?token=test",
        };
        subject = `[TEST] ${buildBudgetWarningSubject(90)}`;
        html = buildBudgetWarningHtml(data);
        text = buildBudgetWarningText(data);
        break;
      }

      case "budget_warning_100": {
        const data = {
          name: fields.name,
          percent: 100,
          usageEur: fields.usageEur ?? 5.0,
          limitEur: fields.limitEur ?? 5.0,
          unsubscribeUrl: "https://fibuki.com/api/budget/unsubscribe?token=test",
        };
        subject = `[TEST] ${buildBudgetWarningSubject(100)}`;
        html = buildBudgetWarningHtml(data);
        text = buildBudgetWarningText(data);
        break;
      }

      case "invite":
        subject = `[TEST] ${buildInviteSubject()}`;
        html = buildInviteHtml(fields.name);
        text = buildInviteText(fields.name);
        break;

      case "password_reset": {
        const sampleLink = "https://fibuki.com/__/auth/action?mode=resetPassword&oobCode=TEST_CODE";
        subject = `[TEST] ${buildPasswordResetSubject()}`;
        html = buildPasswordResetHtml(sampleLink, fields.name);
        text = buildPasswordResetText(sampleLink, fields.name);
        break;
      }

      default:
        throw new HttpsError("invalid-argument", "Unknown template");
    }

    const sgMail = (await import("@sendgrid/mail")).default;
    sgMail.setApiKey(SENDGRID_API_KEY);

    await sgMail.send({
      to: recipientEmail,
      from: { email: FROM_EMAIL, name: FROM_NAME },
      subject,
      html,
      text,
    });

    console.log(`[sendTestEmail] Sent ${template} to ${recipientEmail}`);
    return { success: true };
  }
);
