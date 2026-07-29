/**
 * Selfhost drop-in for `src/utils/mailer` (aliased by path suffix in
 * vitest.selfhost.config.ts): same sendEmail()/isMailerConfigured()
 * surface, but delivery goes over SMTP (Migadu) instead of Resend.
 *
 * Env:
 *   FIBUKI_SMTP_HOST     e.g. "smtp.migadu.com" (required)
 *   FIBUKI_SMTP_PORT     default 465
 *   FIBUKI_SMTP_SECURE   "true"/"false" to force implicit TLS on or off
 *                        (default: on for port 465, off otherwise)
 *   FIBUKI_SMTP_USER     auth mailbox (required)
 *   FIBUKI_SMTP_PASS     (required)
 *   FIBUKI_SMTP_FROM_NAME  display name, default "FiBuKI"
 *   FIBUKI_SMTP_FROM     envelope/From address, default FIBUKI_SMTP_USER
 *
 * From defaults to FIBUKI_SMTP_USER because mailbox providers (Migadu among
 * them) reject mail whose envelope-from does not match the authenticated
 * mailbox, and aligning them by construction is the right default.
 *
 * FIBUKI_SMTP_FROM exists for API-relay providers, where the SMTP username is a
 * fixed literal rather than an address: Resend authenticates as user "resend"
 * with the API key as the password, and SendGrid as "apikey". Pinning From to
 * the username there yields "FiBuKI <resend>", which is not a deliverable
 * address. Leave it unset for a mailbox provider.
 */

import type { Transporter } from "nodemailer";

export interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
}

export function isMailerConfigured(): boolean {
  return Boolean(
    process.env.FIBUKI_SMTP_HOST &&
      process.env.FIBUKI_SMTP_USER &&
      process.env.FIBUKI_SMTP_PASS,
  );
}

let transporter: Transporter | undefined;

/** Test hook: inject a fake transport (and count as configured). */
export function _setTransportForTests(t: Transporter | undefined): void {
  transporter = t;
}

async function getTransport(): Promise<Transporter> {
  if (!transporter) {
    const nodemailer = await import("nodemailer");
    const port = parseInt(process.env.FIBUKI_SMTP_PORT || "465", 10);
    transporter = nodemailer.createTransport({
      host: process.env.FIBUKI_SMTP_HOST,
      port,
      secure:
        process.env.FIBUKI_SMTP_SECURE === "true" ||
        (process.env.FIBUKI_SMTP_SECURE !== "false" && port === 465),
      auth: {
        user: process.env.FIBUKI_SMTP_USER,
        pass: process.env.FIBUKI_SMTP_PASS,
      },
    });
  }
  return transporter;
}

export async function sendEmail(options: SendEmailOptions): Promise<boolean> {
  if (!transporter && !isMailerConfigured()) {
    console.warn(
      `[Mailer:selfhost] SMTP not configured (FIBUKI_SMTP_HOST/USER/PASS), ` +
        `skipping email "${options.subject}"`,
    );
    return false;
  }

  const user = process.env.FIBUKI_SMTP_USER || "selfhost@invalid";
  // Defaults to the authenticated mailbox (envelope alignment); override only
  // for API-relay providers whose username is not an address. See header.
  const fromAddress = process.env.FIBUKI_SMTP_FROM?.trim() || user;
  const fromName = process.env.FIBUKI_SMTP_FROM_NAME || "FiBuKI";
  const transport = await getTransport();

  try {
    await transport.sendMail({
      from: `${fromName} <${fromAddress}>`,
      to: options.to,
      subject: options.subject,
      html: options.html,
      text: options.text,
      ...(options.headers ? { headers: options.headers } : {}),
    });
  } catch (err) {
    // Upstream's Resend path never rejects (the SDK reports errors in its
    // return value), so callers have no try/catch — keep that contract.
    console.error(`[Mailer:selfhost] SMTP send failed for "${options.subject}":`, err);
    return false;
  }

  return true;
}
