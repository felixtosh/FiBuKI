"use strict";
/**
 * Custom password reset email callable.
 * Uses generatePasswordResetLink() + SendGrid to send a branded email.
 * allowUnauthenticated: true — called from the login page.
 * Always returns { success: true } to prevent email enumeration.
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
exports.sendPasswordResetCallable = void 0;
const createCallable_1 = require("../utils/createCallable");
const auth_1 = require("firebase-admin/auth");
const passwordResetEmail_1 = require("./passwordResetEmail");
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || "";
const FROM_EMAIL = "noreply@fibuki.com";
const FROM_NAME = "FiBuKI";
exports.sendPasswordResetCallable = (0, createCallable_1.createCallable)({ name: "sendPasswordReset", allowUnauthenticated: true, skipUsageLogging: true }, async (_ctx, request) => {
    const { email } = request;
    if (!email || !email.includes("@")) {
        // Don't reveal whether the email is valid
        return { success: true };
    }
    try {
        const resetLink = await (0, auth_1.getAuth)().generatePasswordResetLink(email, {
            url: "https://fibuki.com/login",
        });
        if (!SENDGRID_API_KEY) {
            console.warn("[sendPasswordReset] SENDGRID_API_KEY not configured");
            return { success: true };
        }
        // Try to get user display name for personalization
        let name;
        try {
            const user = await (0, auth_1.getAuth)().getUserByEmail(email);
            name = user.displayName || undefined;
        }
        catch {
            // User might not exist — that's fine, we still don't reveal it
        }
        const sgMail = (await Promise.resolve().then(() => __importStar(require("@sendgrid/mail")))).default;
        sgMail.setApiKey(SENDGRID_API_KEY);
        await sgMail.send({
            to: email,
            from: { email: FROM_EMAIL, name: FROM_NAME },
            subject: (0, passwordResetEmail_1.buildPasswordResetSubject)(),
            html: (0, passwordResetEmail_1.buildPasswordResetHtml)(resetLink, name),
            text: (0, passwordResetEmail_1.buildPasswordResetText)(resetLink, name),
        });
        console.log(`[sendPasswordReset] Sent reset email to ${email}`);
    }
    catch (err) {
        // Log but don't expose errors to prevent enumeration
        console.error("[sendPasswordReset] Error:", err);
    }
    return { success: true };
});
//# sourceMappingURL=sendPasswordResetCallable.js.map