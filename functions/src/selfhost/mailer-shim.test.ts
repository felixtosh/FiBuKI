/**
 * Work item 5 — SMTP mailer shim. Proves the alias seam: real application
 * code importing `../utils/mailer` lands in mailer-shim.ts under the
 * selfhost profile, and mail goes to the SMTP transport with the From
 * address pinned to the authenticated mailbox (Migadu alignment).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sendEmail, isMailerConfigured, _setTransportForTests } from "./mailer-shim";

// REAL application code, unmodified — imports ../utils/mailer, which the
// selfhost alias must resolve to the shim above (same module instance).
import { sendInviteEmail } from "../auth/sendInviteEmail";

const SMTP_ENV = [
  "FIBUKI_SMTP_HOST",
  "FIBUKI_SMTP_PORT",
  "FIBUKI_SMTP_SECURE",
  "FIBUKI_SMTP_USER",
  "FIBUKI_SMTP_PASS",
  "FIBUKI_SMTP_FROM_NAME",
];

const sendMail = vi.fn().mockResolvedValue({ messageId: "m-1" });

beforeEach(() => {
  sendMail.mockClear();
  for (const k of SMTP_ENV) delete process.env[k];
});

afterEach(() => {
  _setTransportForTests(undefined);
  for (const k of SMTP_ENV) delete process.env[k];
});

function withFakeTransport() {
  process.env.FIBUKI_SMTP_HOST = "smtp.migadu.com";
  process.env.FIBUKI_SMTP_USER = "fibuki@syh.at";
  process.env.FIBUKI_SMTP_PASS = "secret";
  _setTransportForTests({ sendMail } as never);
}

describe("selfhost mailer shim (SMTP)", () => {
  it("skips loudly and returns false when SMTP is unconfigured", async () => {
    expect(isMailerConfigured()).toBe(false);
    const sent = await sendEmail({
      to: "user@example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
    });
    expect(sent).toBe(false);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("pins From to the authenticated mailbox and passes headers through", async () => {
    withFakeTransport();

    const sent = await sendEmail({
      to: "user@example.com",
      subject: "Weekly digest",
      html: "<p>Digest</p>",
      text: "Digest",
      headers: { "List-Unsubscribe": "<https://example.com/u>" },
    });

    expect(sent).toBe(true);
    expect(sendMail).toHaveBeenCalledWith({
      from: "FiBuKI <fibuki@syh.at>",
      to: "user@example.com",
      subject: "Weekly digest",
      html: "<p>Digest</p>",
      text: "Digest",
      headers: { "List-Unsubscribe": "<https://example.com/u>" },
    });
  });

  it("REAL sendInviteEmail flows through the shim via the utils/mailer alias", async () => {
    withFakeTransport();

    await sendInviteEmail("invitee@example.com");

    expect(sendMail).toHaveBeenCalledTimes(1);
    const mail = sendMail.mock.calls[0][0];
    expect(mail.to).toBe("invitee@example.com");
    expect(mail.from).toBe("FiBuKI <fibuki@syh.at>");
    expect(mail.subject.length).toBeGreaterThan(0);
    expect(mail).not.toHaveProperty("headers");
  });
});
