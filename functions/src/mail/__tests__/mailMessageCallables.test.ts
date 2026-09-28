/**
 * #245: an IMAP mailbox can be attached from, not only synced. The two
 * callables read one attachment and one message body through the provider
 * factory the Sync worker uses, and refuse what is not the caller's.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  integrations: {} as Record<string, Record<string, unknown>>,
  tokens: {} as Record<string, Record<string, unknown>>,
  provider: {
    getMessage: vi.fn(),
    getAttachment: vi.fn(),
    getBody: vi.fn(),
    close: vi.fn(),
    search: vi.fn(),
  },
  makeProvider: vi.fn(),
}));

vi.mock("../../utils/createCallable", () => ({
  createCallable: <TReq, TRes>(
    _config: { name: string },
    handler: (ctx: unknown, data: TReq) => Promise<TRes>
  ) => handler,
  HttpsError: class HttpsError extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
}));
vi.mock("firebase-functions/params", () => ({
  defineSecret: (name: string) => ({ value: () => `test-${name}` }),
}));
vi.mock("../index", () => ({ makeProvider: h.makeProvider }));
vi.mock("../imap/config", () => ({
  imapConfigFromIntegration: () => ({ host: "imap.example", user: "me@example.at" }),
}));

import { getMailAttachmentCallable, getMailBodyCallable } from "../mailMessageCallables";

const USER = "u1";

const db = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      get: async () => {
        const data = name === "emailIntegrations" ? h.integrations[id] : h.tokens[id];
        return { exists: data !== undefined, data: () => data };
      },
    }),
  }),
};

type Handler<Req, Res> = (ctx: unknown, req: Req) => Promise<Res>;
const attach = getMailAttachmentCallable as unknown as Handler<
  Record<string, string>,
  { filename: string; mimeType: string; dataBase64: string; integrationEmail: string | null }
>;
const body = getMailBodyCallable as unknown as Handler<
  Record<string, string>,
  { htmlBody: string; textBody: string; subject: string }
>;
const ctx = { userId: USER, db };

const MESSAGE = {
  id: "42",
  messageId: "<a@b>",
  from: "Hetzner <billing@hetzner.com>",
  subject: "Rechnung",
  date: new Date("2026-07-01T00:00:00Z"),
  attachments: [
    { attachmentId: "2", filename: "invoice.pdf", mimeType: "application/pdf", size: 7 },
  ],
};

beforeEach(() => {
  h.integrations = {
    imap1: { userId: USER, provider: "imap", email: "me@example.at" },
    gmail1: { userId: USER, provider: "gmail", email: "me@gmail.com" },
    other: { userId: "someone-else", provider: "imap" },
    stale: { userId: USER, provider: "imap", needsReauth: true },
  };
  h.tokens = { imap1: { secret: "s", secretIv: "iv" } };
  for (const fn of Object.values(h.provider)) fn.mockReset();
  h.provider.getMessage.mockResolvedValue(MESSAGE);
  h.provider.getAttachment.mockResolvedValue(Buffer.from("%PDF-1"));
  h.provider.getBody.mockResolvedValue({ html: "<p>Rechnung</p>", text: null });
  h.makeProvider.mockReset();
  h.makeProvider.mockReturnValue(h.provider);
});

describe("getMailAttachmentCallable", () => {
  it("returns an IMAP attachment's bytes through the provider factory", async () => {
    const res = await attach(ctx, { integrationId: "imap1", messageId: "42", attachmentId: "2" });
    expect(h.makeProvider).toHaveBeenCalledWith("imap", expect.anything());
    expect(res.filename).toBe("invoice.pdf");
    expect(res.mimeType).toBe("application/pdf");
    expect(Buffer.from(res.dataBase64, "base64").toString()).toBe("%PDF-1");
    expect(res.integrationEmail).toBe("me@example.at");
    expect(h.provider.close).toHaveBeenCalled();
  });

  it("refuses another user's integration as not found", async () => {
    await expect(
      attach(ctx, { integrationId: "other", messageId: "42", attachmentId: "2" })
    ).rejects.toMatchObject({ code: "not-found" });
    expect(h.makeProvider).not.toHaveBeenCalled();
  });

  it("reports a mailbox needing re-authentication as such", async () => {
    await expect(
      attach(ctx, { integrationId: "stale", messageId: "42", attachmentId: "2" })
    ).rejects.toThrow(/Re-authentication required/);
  });

  it("leaves Gmail to its own client", async () => {
    await expect(
      attach(ctx, { integrationId: "gmail1", messageId: "42", attachmentId: "2" })
    ).rejects.toMatchObject({ code: "failed-precondition" });
  });

  it("refuses an attachment the message does not carry", async () => {
    await expect(
      attach(ctx, { integrationId: "imap1", messageId: "42", attachmentId: "9" })
    ).rejects.toMatchObject({ code: "not-found" });
    expect(h.provider.close).toHaveBeenCalled();
  });
});

describe("getMailBodyCallable", () => {
  it("returns the body and headers of an IMAP message", async () => {
    const res = await body(ctx, { integrationId: "imap1", messageId: "42" });
    expect(res).toMatchObject({ htmlBody: "<p>Rechnung</p>", textBody: "", subject: "Rechnung" });
    expect(h.provider.close).toHaveBeenCalled();
  });
});
