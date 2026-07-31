/**
 * PR-1a regression coverage for the extracted mail provider abstraction.
 *
 * The Gmail search/parse/fetch logic used to live inline in
 * gmail/gmailSyncQueue.ts with no tests. It moved behind MailProvider /
 * GmailProvider; this pins the behavior that the queue worker relies on:
 * query construction, header + date parsing, invoice-type attachment
 * filtering (incl. nested parts), base64url attachment decoding, and the
 * factory's provider selection.
 *
 * GmailProvider talks only to global fetch, so no Firebase shims are needed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GmailProvider, makeProvider, MailProvider } from "../index";

// ---- fetch mock -------------------------------------------------------------

interface FetchCall { url: string }
let calls: FetchCall[] = [];
let handler: (url: string) => { ok: boolean; status?: number; body: unknown };

function jsonResponse(body: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push({ url });
    const r = handler(url);
    return jsonResponse(r.body, r.ok, r.status ?? 200);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---- search -----------------------------------------------------------------

describe("GmailProvider.search", () => {
  it("builds the invoice query with keywords + date window and honors pageToken", async () => {
    handler = () => ({ ok: true, body: { messages: [{ id: "m1" }, { id: "m2" }], nextPageToken: "TOK" } });
    const provider = new GmailProvider("access-123");

    const page = await provider.search({
      dateFrom: new Date("2025-03-10T00:00:00Z"),
      dateTo: new Date("2025-03-20T00:00:00Z"),
      pageToken: "PREV",
    });

    expect(page.messages).toEqual([{ id: "m1" }, { id: "m2" }]);
    expect(page.nextPageToken).toBe("TOK");

    // URLSearchParams encodes spaces as "+"; normalize back for readability
    const q = decodeURIComponent(calls[0].url).replace(/\+/g, " ");
    expect(q).toContain("/users/me/messages?");
    expect(q).toContain('"Rechnung"');
    expect(q).toContain('"Invoice"');
    expect(q).toContain("has:attachment filename:pdf");
    // before: is exclusive and set to dateTo + 1 day
    expect(q).toContain("after:2025/03/10");
    expect(q).toContain("before:2025/03/21");
    expect(q).toContain("pageToken=PREV");
  });

  it("passes the bearer token", async () => {
    handler = () => ({ ok: true, body: { messages: [] } });
    await new GmailProvider("secret-tok").search({
      dateFrom: new Date("2025-01-01"),
      dateTo: new Date("2025-01-02"),
    });
    const mockFetch = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const init = mockFetch.mock.calls[0][1];
    expect(init.headers.Authorization).toBe("Bearer secret-tok");
  });
});

// ---- getMessage -------------------------------------------------------------

const MESSAGE_FIXTURE = {
  id: "m1",
  threadId: "t1",
  internalDate: "1710000000000", // 2024-03-09T16:00:00Z
  payload: {
    mimeType: "multipart/mixed",
    headers: [
      { name: "From", value: '"Acme GmbH" <billing@acme.example>' },
      { name: "Subject", value: "Ihre Rechnung 42" },
      { name: "Message-ID", value: "<abc-123@acme.example>" },
    ],
    parts: [
      { partId: "0", mimeType: "text/plain", filename: "", body: { size: 10 } },
      { partId: "1", mimeType: "application/pdf", filename: "rechnung.pdf", body: { attachmentId: "att-pdf", size: 2048 } },
      {
        partId: "2",
        mimeType: "multipart/alternative",
        filename: "",
        body: {},
        parts: [
          { partId: "2.0", mimeType: "image/png", filename: "scan.png", body: { attachmentId: "att-png", size: 500 } },
          { partId: "2.1", mimeType: "application/zip", filename: "junk.zip", body: { attachmentId: "att-zip", size: 999 } },
        ],
      },
    ],
  },
};

describe("GmailProvider.getMessage", () => {
  it("parses headers + date and keeps only invoice-type attachments, recursing nested parts", async () => {
    handler = () => ({ ok: true, body: MESSAGE_FIXTURE });
    const msg = await new GmailProvider("t").getMessage({ id: "m1" });

    expect(msg.id).toBe("m1");
    expect(msg.from).toBe('"Acme GmbH" <billing@acme.example>');
    expect(msg.subject).toBe("Ihre Rechnung 42");
    expect(msg.messageId).toBe("<abc-123@acme.example>");
    expect(msg.date.getTime()).toBe(1710000000000);

    // pdf + nested png kept; text/plain (no attachmentId) and zip (wrong mime) dropped
    expect(msg.attachments.map((a) => a.attachmentId).sort()).toEqual(["att-pdf", "att-png"]);
    const pdf = msg.attachments.find((a) => a.attachmentId === "att-pdf")!;
    expect(pdf).toMatchObject({ filename: "rechnung.pdf", mimeType: "application/pdf", size: 2048 });
  });

  it("tolerates a missing Message-ID header", async () => {
    const noMsgId = {
      ...MESSAGE_FIXTURE,
      payload: { ...MESSAGE_FIXTURE.payload, headers: [{ name: "From", value: "x@y.z" }] },
    };
    handler = () => ({ ok: true, body: noMsgId });
    const msg = await new GmailProvider("t").getMessage({ id: "m1" });
    expect(msg.messageId).toBeNull();
    expect(msg.subject).toBe("");
  });
});

// ---- getAttachment ----------------------------------------------------------

describe("GmailProvider.getAttachment", () => {
  it("base64url-decodes attachment bytes", async () => {
    // "héllo" contains a non-url-safe char once base64'd; use base64url form
    const raw = Buffer.from("héllo", "utf8");
    const b64url = raw.toString("base64").replace(/\+/g, "-").replace(/\//g, "_");
    handler = () => ({ ok: true, body: { data: b64url } });

    const out = await new GmailProvider("t").getAttachment(
      { id: "m1", messageId: null, from: "", subject: "", date: new Date(), attachments: [] },
      { attachmentId: "att-pdf", filename: "f.pdf", mimeType: "application/pdf", size: 5 }
    );
    expect(out.equals(raw)).toBe(true);
  });
});

// ---- factory ----------------------------------------------------------------

describe("makeProvider", () => {
  it("returns a GmailProvider for provider=gmail with a token", () => {
    const p: MailProvider = makeProvider("gmail", { accessToken: "tok" });
    expect(p).toBeInstanceOf(GmailProvider);
  });

  it("throws for gmail without an access token", () => {
    expect(() => makeProvider("gmail", {})).toThrow(/access token/i);
  });

  it("throws for an unknown provider", () => {
    expect(() => makeProvider("carrier-pigeon", {})).toThrow(/Unknown mail provider/);
  });
});
