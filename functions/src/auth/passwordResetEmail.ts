/**
 * Password reset email template builder.
 */

import { wrapEmailHtml, emailButton, emailGreeting } from "../emails/emailLayout";

export function buildPasswordResetSubject(): string {
  return "Reset your password";
}

export function buildPasswordResetHtml(resetLink: string, name?: string): string {
  let body = emailGreeting(name);

  body += `<p style="margin:0 0 16px;">We received a request to reset your password. Click the button below to choose a new one.</p>`;
  body += emailButton("Reset Password", resetLink);
  body += `<p style="margin:0 0 16px;color:#6b7280;font-size:13px;">This link expires in 1 hour. If you didn&rsquo;t request a password reset, you can safely ignore this email.</p>`;

  return wrapEmailHtml(body);
}

export function buildPasswordResetText(resetLink: string, name?: string): string {
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
