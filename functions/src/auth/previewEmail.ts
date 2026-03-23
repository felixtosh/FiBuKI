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
import { resolveMergeFields, MergeFields } from "../emails/resolveMergeFields";

type EmailTemplate = "digest" | "budget_warning_90" | "budget_warning_100" | "invite" | "password_reset";

interface PreviewEmailRequest {
  template: EmailTemplate;
  mergeFieldsEmail?: string;
}

interface PreviewEmailResponse {
  subject: string;
  html: string;
  text: string;
  mergeFields: MergeFields;
}

const VALID_TEMPLATES: EmailTemplate[] = [
  "digest",
  "budget_warning_90",
  "budget_warning_100",
  "invite",
  "password_reset",
];

export const previewEmailCallable = createCallable<
  PreviewEmailRequest,
  PreviewEmailResponse
>(
  { name: "previewEmail" },
  async (ctx, request) => {
    // Admin only
    if (!ctx.request.auth?.token.admin) {
      throw new HttpsError("permission-denied", "Admin only");
    }

    const { template, mergeFieldsEmail } = request;

    if (!VALID_TEMPLATES.includes(template)) {
      throw new HttpsError(
        "invalid-argument",
        `template must be one of: ${VALID_TEMPLATES.join(", ")}`
      );
    }

    const fields = await resolveMergeFields(ctx.db, template, mergeFieldsEmail);

    switch (template) {
      case "digest": {
        const stats = {
          newTransactions: fields.newTransactions ?? 42,
          unmatchedTransactions: fields.unmatchedTransactions ?? 7,
          completionRate: fields.completionRate ?? 83,
          newFiles: fields.newFiles ?? 12,
        };
        const unsubscribeUrl = "https://fibuki.com/api/digest/unsubscribe?token=sample";
        return {
          subject: buildDigestSubject(stats),
          html: buildDigestHtml(stats, unsubscribeUrl, fields.name),
          text: buildDigestText(stats, unsubscribeUrl, fields.name),
          mergeFields: fields,
        };
      }

      case "budget_warning_90": {
        const data = {
          name: fields.name,
          percent: 90,
          usageEur: fields.usageEur ?? 4.5,
          limitEur: fields.limitEur ?? 5.0,
          unsubscribeUrl: "https://fibuki.com/api/budget/unsubscribe?token=sample",
        };
        return {
          subject: buildBudgetWarningSubject(90),
          html: buildBudgetWarningHtml(data),
          text: buildBudgetWarningText(data),
          mergeFields: fields,
        };
      }

      case "budget_warning_100": {
        const data = {
          name: fields.name,
          percent: 100,
          usageEur: fields.usageEur ?? 5.0,
          limitEur: fields.limitEur ?? 5.0,
          unsubscribeUrl: "https://fibuki.com/api/budget/unsubscribe?token=sample",
        };
        return {
          subject: buildBudgetWarningSubject(100),
          html: buildBudgetWarningHtml(data),
          text: buildBudgetWarningText(data),
          mergeFields: fields,
        };
      }

      case "invite":
        return {
          subject: buildInviteSubject(),
          html: buildInviteHtml(fields.name),
          text: buildInviteText(fields.name),
          mergeFields: fields,
        };

      case "password_reset": {
        const sampleLink = "https://fibuki.com/__/auth/action?mode=resetPassword&oobCode=SAMPLE_CODE";
        return {
          subject: buildPasswordResetSubject(),
          html: buildPasswordResetHtml(sampleLink, fields.name),
          text: buildPasswordResetText(sampleLink, fields.name),
          mergeFields: fields,
        };
      }

      default:
        throw new HttpsError("invalid-argument", "Unknown template");
    }
  }
);
