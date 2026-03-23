"use strict";
/**
 * Admin-only callable to send a test email to a given recipient.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.sendTestEmailCallable = void 0;
const createCallable_1 = require("../utils/createCallable");
const digestEmail_1 = require("../digest/digestEmail");
const inviteEmail_1 = require("./inviteEmail");
const budgetWarningEmail_1 = require("../billing/budgetWarningEmail");
const passwordResetEmail_1 = require("./passwordResetEmail");
const resolveMergeFields_1 = require("../emails/resolveMergeFields");
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = "noreply@fibuki.com";
const FROM_NAME = "FiBuKI";
exports.sendTestEmailCallable = (0, createCallable_1.createCallable)({ name: "sendTestEmail" }, async (ctx, request) => {
    if (!ctx.request.auth?.token.admin) {
        throw new createCallable_1.HttpsError("permission-denied", "Admin only");
    }
    const { template, recipientEmail, mergeFieldsEmail } = request;
    if (!recipientEmail || !recipientEmail.includes("@")) {
        throw new createCallable_1.HttpsError("invalid-argument", "Valid recipientEmail is required");
    }
    if (!SENDGRID_API_KEY) {
        throw new createCallable_1.HttpsError("failed-precondition", "SENDGRID_API_KEY not configured");
    }
    const fields = await (0, resolveMergeFields_1.resolveMergeFields)(ctx.db, template, mergeFieldsEmail);
    let subject;
    let html;
    let text;
    switch (template) {
        case "digest": {
            const stats = {
                newTransactions: fields.newTransactions ?? 42,
                unmatchedTransactions: fields.unmatchedTransactions ?? 7,
                completionRate: fields.completionRate ?? 83,
                newFiles: fields.newFiles ?? 12,
            };
            const unsubscribeUrl = "https://fibuki.com/api/digest/unsubscribe?token=test";
            subject = `[TEST] ${(0, digestEmail_1.buildDigestSubject)(stats)}`;
            html = (0, digestEmail_1.buildDigestHtml)(stats, unsubscribeUrl, fields.name);
            text = (0, digestEmail_1.buildDigestText)(stats, unsubscribeUrl, fields.name);
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
            subject = `[TEST] ${(0, budgetWarningEmail_1.buildBudgetWarningSubject)(90)}`;
            html = (0, budgetWarningEmail_1.buildBudgetWarningHtml)(data);
            text = (0, budgetWarningEmail_1.buildBudgetWarningText)(data);
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
            subject = `[TEST] ${(0, budgetWarningEmail_1.buildBudgetWarningSubject)(100)}`;
            html = (0, budgetWarningEmail_1.buildBudgetWarningHtml)(data);
            text = (0, budgetWarningEmail_1.buildBudgetWarningText)(data);
            break;
        }
        case "invite":
            subject = `[TEST] ${(0, inviteEmail_1.buildInviteSubject)()}`;
            html = (0, inviteEmail_1.buildInviteHtml)(fields.name);
            text = (0, inviteEmail_1.buildInviteText)(fields.name);
            break;
        case "password_reset": {
            const sampleLink = "https://fibuki.com/__/auth/action?mode=resetPassword&oobCode=TEST_CODE";
            subject = `[TEST] ${(0, passwordResetEmail_1.buildPasswordResetSubject)()}`;
            html = (0, passwordResetEmail_1.buildPasswordResetHtml)(sampleLink, fields.name);
            text = (0, passwordResetEmail_1.buildPasswordResetText)(sampleLink, fields.name);
            break;
        }
        default:
            throw new createCallable_1.HttpsError("invalid-argument", "Unknown template");
    }
    const sgMail = (await Promise.resolve().then(() => __importStar(require("@sendgrid/mail")))).default;
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
});
//# sourceMappingURL=sendTestEmail.js.map