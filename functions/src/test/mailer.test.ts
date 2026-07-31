import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const sendMock = vi.fn().mockResolvedValue({ data: { id: "email-1" } });

vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendMock };
  },
}));

import { sendEmail, isMailerConfigured } from "../utils/mailer";

describe("central mailer", () => {
  const originalKey = process.env.RESEND_API_KEY;

  beforeEach(() => {
    sendMock.mockClear();
  });

  afterEach(() => {
    if (originalKey === undefined) delete process.env.RESEND_API_KEY;
    else process.env.RESEND_API_KEY = originalKey;
  });

  it("reports unconfigured and skips sending without RESEND_API_KEY", async () => {
    delete process.env.RESEND_API_KEY;

    expect(isMailerConfigured()).toBe(false);
    const sent = await sendEmail({
      to: "user@example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
    });

    expect(sent).toBe(false);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("sends with the FiBuKI from-address and passes headers through", async () => {
    process.env.RESEND_API_KEY = "re_test_key";

    expect(isMailerConfigured()).toBe(true);
    const sent = await sendEmail({
      to: "user@example.com",
      subject: "Weekly digest",
      html: "<p>Digest</p>",
      text: "Digest",
      headers: { "List-Unsubscribe": "<https://example.com/u>" },
    });

    expect(sent).toBe(true);
    expect(sendMock).toHaveBeenCalledWith({
      to: "user@example.com",
      from: "FiBuKI <noreply@fibuki.com>",
      subject: "Weekly digest",
      html: "<p>Digest</p>",
      text: "Digest",
      headers: { "List-Unsubscribe": "<https://example.com/u>" },
    });
  });

  it("omits the headers key when none are given", async () => {
    process.env.RESEND_API_KEY = "re_test_key";

    await sendEmail({
      to: "user@example.com",
      subject: "Hi",
      html: "<p>Hi</p>",
      text: "Hi",
    });

    expect(sendMock.mock.calls[0][0]).not.toHaveProperty("headers");
  });
});
