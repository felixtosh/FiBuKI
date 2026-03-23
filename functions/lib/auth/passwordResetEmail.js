"use strict";
/**
 * Password reset email template builder.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.buildPasswordResetSubject = buildPasswordResetSubject;
exports.buildPasswordResetHtml = buildPasswordResetHtml;
exports.buildPasswordResetText = buildPasswordResetText;
const emailLayout_1 = require("../emails/emailLayout");
function buildPasswordResetSubject() {
    return "Reset your password";
}
function buildPasswordResetHtml(resetLink, name) {
    let body = (0, emailLayout_1.emailGreeting)(name);
    body += `<p style="margin:0 0 16px;">We received a request to reset your password. Click the button below to choose a new one.</p>`;
    body += (0, emailLayout_1.emailButton)("Reset Password", resetLink);
    body += `<p style="margin:0 0 16px;color:#6b7280;font-size:13px;">This link expires in 1 hour. If you didn&rsquo;t request a password reset, you can safely ignore this email.</p>`;
    return (0, emailLayout_1.wrapEmailHtml)(body);
}
function buildPasswordResetText(resetLink, name) {
    const greeting = name ? `Hi ${name.split(" ")[0]},` : "Hi,";
    return [
        greeting,
        "",
        "We received a request to reset your password. Use the link below to choose a new one:",
        "",
        resetLink,
        "",
        "This link expires in 1 hour. If you didn't request a password reset, you can safely ignore this email.",
    ].join("\n");
}
//# sourceMappingURL=passwordResetEmail.js.map