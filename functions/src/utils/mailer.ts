/**
 * Central mailer — the single place that talks to the email provider.
 *
 * All outbound email goes through sendEmail(); callers build subject/html/
 * text with their template helpers and never touch Resend directly. The
 * provider API key is read from process.env.RESEND_API_KEY: Cloud Functions
 * v2 mounts declared secrets as env vars of the same name, so functions
 * keep `secrets: [resendApiKey]` in their options and nothing else changes.
 */

const FROM_EMAIL = "noreply@fibuki.com";
const FROM_NAME = "FiBuKI";

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** Extra SMTP headers, e.g. List-Unsubscribe for the weekly digest. */
  headers?: Record<string, string>;
}

/** True when the provider API key is available to this function. */
export function isMailerConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY);
}

/**
 * Send one email. Returns true when handed to the provider, false when the
 * mailer is unconfigured (logged once per call — callers that must hard-fail
 * instead should check isMailerConfigured() first).
 */
export async function sendEmail(options: SendEmailOptions): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    // Deliberately no recipient address here — this line fires in shared logs.
    console.warn(
      `[Mailer] RESEND_API_KEY not configured, skipping email "${options.subject}"`
    );
    return false;
  }

  const { Resend } = await import("resend");
  const resend = new Resend(apiKey);

  await resend.emails.send({
    to: options.to,
    from: `${FROM_NAME} <${FROM_EMAIL}>`,
    subject: options.subject,
    html: options.html,
    text: options.text,
    ...(options.headers ? { headers: options.headers } : {}),
  });

  return true;
}
