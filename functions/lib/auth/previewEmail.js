"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.previewEmailCallable = void 0;
const createCallable_1 = require("../utils/createCallable");
const digestEmail_1 = require("../digest/digestEmail");
const inviteEmail_1 = require("./inviteEmail");
const budgetWarningEmail_1 = require("../billing/budgetWarningEmail");
const passwordResetEmail_1 = require("./passwordResetEmail");
const resolveMergeFields_1 = require("../emails/resolveMergeFields");
const VALID_TEMPLATES = [
    "digest",
    "budget_warning_90",
    "budget_warning_100",
    "invite",
    "password_reset",
];
exports.previewEmailCallable = (0, createCallable_1.createCallable)({ name: "previewEmail" }, async (ctx, request) => {
    // Admin only
    if (!ctx.request.auth?.token.admin) {
        throw new createCallable_1.HttpsError("permission-denied", "Admin only");
    }
    const { template, mergeFieldsEmail } = request;
    if (!VALID_TEMPLATES.includes(template)) {
        throw new createCallable_1.HttpsError("invalid-argument", `template must be one of: ${VALID_TEMPLATES.join(", ")}`);
    }
    const fields = await (0, resolveMergeFields_1.resolveMergeFields)(ctx.db, template, mergeFieldsEmail);
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
                subject: (0, digestEmail_1.buildDigestSubject)(stats),
                html: (0, digestEmail_1.buildDigestHtml)(stats, unsubscribeUrl, fields.name),
                text: (0, digestEmail_1.buildDigestText)(stats, unsubscribeUrl, fields.name),
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
                subject: (0, budgetWarningEmail_1.buildBudgetWarningSubject)(90),
                html: (0, budgetWarningEmail_1.buildBudgetWarningHtml)(data),
                text: (0, budgetWarningEmail_1.buildBudgetWarningText)(data),
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
                subject: (0, budgetWarningEmail_1.buildBudgetWarningSubject)(100),
                html: (0, budgetWarningEmail_1.buildBudgetWarningHtml)(data),
                text: (0, budgetWarningEmail_1.buildBudgetWarningText)(data),
                mergeFields: fields,
            };
        }
        case "invite":
            return {
                subject: (0, inviteEmail_1.buildInviteSubject)(),
                html: (0, inviteEmail_1.buildInviteHtml)(fields.name),
                text: (0, inviteEmail_1.buildInviteText)(fields.name),
                mergeFields: fields,
            };
        case "password_reset": {
            const sampleLink = "https://fibuki.com/__/auth/action?mode=resetPassword&oobCode=SAMPLE_CODE";
            return {
                subject: (0, passwordResetEmail_1.buildPasswordResetSubject)(),
                html: (0, passwordResetEmail_1.buildPasswordResetHtml)(sampleLink, fields.name),
                text: (0, passwordResetEmail_1.buildPasswordResetText)(sampleLink, fields.name),
                mergeFields: fields,
            };
        }
        default:
            throw new createCallable_1.HttpsError("invalid-argument", "Unknown template");
    }
});
//# sourceMappingURL=previewEmail.js.map