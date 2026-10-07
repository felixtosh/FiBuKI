/**
 * Unit coverage for the IMAP provider (PR-2).
 *
 * imapflow is mocked, so these tests pin ImapProvider's own logic:
 * date-window + keyword search construction, UID-descending pagination cursor
 * math, BODYSTRUCTURE attachment filtering (invoice mimetypes, nested parts,
 * filename sources), envelope mapping + Message-ID fallback, attachment stream
 * decoding, self-signed TLS gating, and the factory's `case "imap"`.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// ---- imapflow mock ----------------------------------------------------------

// vi.mock is hoisted above imports, so the mock class + its shared mutable
// state must be created via vi.hoisted (also hoisted) to be in scope.
const { state } = vi.hoisted(() => {
  const state = {
    ctorOpts: null as Record<string, unknown> | null,
    searchQuery: null as unknown,
    searchResult: [] as number[] | false,
    /** Make the next search() throw, as a server rejecting a BODY search does. */
    searchThrows: false,
    /** Sequence handed to fetch() by the bounded scan. */
    fetchRange: null as unknown,
    /** Envelopes the bounded scan walks. */
    fetchList: [] as Array<Record<string, unknown>>,
    /** Every UID set a BODYSTRUCTURE fetch asked for, in call order. */
    structureFetches: [] as number[][],
    /** A UID's BODYSTRUCTURE; a UID not named here gets defaultStructure. */
    structures: {} as Record<number, unknown>,
    defaultStructure: null as unknown,
    fetchResult: null as unknown,
    downloadPart: null as string | null,
    downloadBuffer: Buffer.from("PDFDATA"),
    /** Per-part bytes; a part named here wins over downloadBuffer. */
    downloadBuffers: {} as Record<string, Buffer>,
    downloadParts: [] as string[],
    mailboxOpened: null as string | string[] | null,
    loggedOut: false,
  };
  return { state };
});

vi.mock("imapflow", async () => {
  const { Readable } = await import("stream");
  class MockImapFlow {
    constructor(opts: Record<string, unknown>) {
      state.ctorOpts = opts;
    }
    async connect() {}
    async mailboxOpen(path: string | string[]) {
      state.mailboxOpened = path;
      return { path } as unknown;
    }
    async search(query: unknown) {
      state.searchQuery = query;
      if (state.searchThrows) {
        state.searchThrows = false;
        throw new Error("BAD SEARCH");
      }
      return state.searchResult;
    }
    async *fetch(range: unknown, query: { bodyStructure?: boolean }) {
      if (query?.bodyStructure) {
        // The attachment check: answer per UID, ascending, as a server does.
        const uids = (range as number[]).slice().sort((a, b) => a - b);
        state.structureFetches.push(uids);
        for (const uid of uids) {
          yield { uid, bodyStructure: state.structures[uid] ?? state.defaultStructure };
        }
        return;
      }
      state.fetchRange = range;
      for (const msg of state.fetchList) yield msg;
    }
    async fetchOne() {
      return state.fetchResult;
    }
    async download(range: string, part: string) {
      state.downloadPart = part;
      state.downloadParts.push(part);
      const bytes = state.downloadBuffers[part] ?? state.downloadBuffer;
      return { meta: {}, content: Readable.from([bytes]) };
    }
    async logout() {
      state.loggedOut = true;
    }
    close() {}
  }
  return { ImapFlow: MockImapFlow };
});

import { ImapProvider, ImapConfig } from "../imap/ImapProvider";
import { makeProvider } from "../index";
import { MAX_IMAP_ATTACHMENT_CHECKS, MAX_IMAP_SCAN_MESSAGES } from "../constants";

const PDF = {
  type: "multipart/mixed",
  childNodes: [
    { part: "1", type: "text/plain" },
    {
      part: "2",
      type: "application/pdf",
      disposition: "attachment",
      dispositionParameters: { filename: "invoice.pdf" },
    },
  ],
};
const NO_ATTACHMENT = { type: "text/html" };
const ZIP_ONLY = {
  type: "multipart/mixed",
  childNodes: [
    { part: "1", type: "text/plain" },
    {
      part: "2",
      type: "application/zip",
      disposition: "attachment",
      dispositionParameters: { filename: "logs.zip" },
    },
  ],
};

function cfg(over: Partial<ImapConfig> = {}): ImapConfig {
  return {
    host: "10.30.30.95",
    port: 993,
    secure: true,
    allowSelfSigned: true,
    mailbox: "INBOX",
    keywordPrefilter: true,
    user: "gmail-yazzbert",
    password: "secret",
    ...over,
  };
}

beforeEach(() => {
  state.ctorOpts = null;
  state.searchQuery = null;
  state.searchResult = [];
  state.searchThrows = false;
  state.fetchRange = null;
  state.fetchList = [];
  state.structureFetches = [];
  state.structures = {};
  // Every match carries a PDF unless a test says otherwise, so the tests that
  // pin the query and the cursor are not about attachments.
  state.defaultStructure = PDF;
  state.fetchResult = null;
  state.downloadPart = null;
  state.downloadBuffers = {};
  state.downloadParts = [];
  state.mailboxOpened = null;
  state.loggedOut = false;
});

// ---- search -----------------------------------------------------------------

describe("ImapProvider.search", () => {
  it("builds a since/before window with keyword pre-filter and sorts UIDs desc", async () => {
    state.searchResult = [5, 20, 12, 3];
    const provider = new ImapProvider(cfg());

    const page = await provider.search({
      dateFrom: new Date("2025-03-10T00:00:00Z"),
      dateTo: new Date("2025-03-20T00:00:00Z"),
    });

    const q = state.searchQuery as { since: string; before: string; or?: unknown[] };
    // Date-only strings (not Date objects) → imapflow emits absolute SINCE/BEFORE.
    expect(q.since).toBe("2025-03-10");
    // before is dateTo + 1 day (inclusive window)
    expect(q.before).toBe("2025-03-21");
    expect(Array.isArray(q.or)).toBe(true);
    expect((q.or as unknown[]).length).toBeGreaterThan(0);

    // newest UID first
    expect(page.messages).toEqual([
      { id: "20" },
      { id: "12" },
      { id: "5" },
      { id: "3" },
    ]);
    expect(page.nextPageToken).toBeUndefined();
    expect(state.mailboxOpened).toBe("INBOX");
  });

  it("omits the keyword clause when keywordPrefilter is off", async () => {
    state.searchResult = [1];
    const provider = new ImapProvider(cfg({ keywordPrefilter: false }));
    await provider.search({ dateFrom: new Date(), dateTo: new Date() });
    expect((state.searchQuery as { or?: unknown }).or).toBeUndefined();
  });

  it("paginates below the cursor and emits nextPageToken when more remain", async () => {
    // 60 UIDs 60..1; batch size 50 → first page is 60..11, cursor 11
    state.searchResult = Array.from({ length: 60 }, (_, i) => i + 1);
    const provider = new ImapProvider(cfg());

    const first = await provider.search({ dateFrom: new Date(), dateTo: new Date() });
    expect(first.messages.length).toBe(50);
    expect(first.messages[0]).toEqual({ id: "60" });
    expect(first.nextPageToken).toBe("11");

    const second = await provider.search({
      dateFrom: new Date(),
      dateTo: new Date(),
      pageToken: "11",
    });
    // strictly below 11 → 10..1
    expect(second.messages.length).toBe(10);
    expect(second.messages[0]).toEqual({ id: "10" });
    expect(second.nextPageToken).toBeUndefined();
  });

  // ---- the shared search shape (#240) ---------------------------------------
  //
  // The same neutral terms GmailProvider.test.ts runs against a Gmail mailbox.
  // IMAP executes the keywords and the sender server-side and says so about the
  // two it cannot: filenames (no SEARCH key) and the attachment flag
  // (BODYSTRUCTURE is only visible after a fetch).
  it("executes a provider-neutral search and reports what it cannot execute", async () => {
    state.searchResult = [12, 31];
    const provider = new ImapProvider(cfg());

    const page = await provider.search({
      keywords: ["netflix", "rechnung"],
      from: "netflix.com",
      filenames: ["pdf"],
      dateFrom: new Date("2026-07-01T00:00:00Z"),
      dateTo: new Date("2026-07-31T00:00:00Z"),
      limit: 20,
    });

    const q = state.searchQuery as Record<string, unknown>;
    expect(q.since).toBe("2026-07-01");
    expect(q.before).toBe("2026-08-01");
    expect(q.from).toBe("netflix.com");
    // Both words must hit. IMAP has no `and` for two OR-clauses, so the
    // conjunction is De Morgan's: NOT (NOT netflix OR NOT rechnung).
    expect(q.not).toEqual({
      or: [
        { not: { or: [{ subject: "netflix" }, { body: "netflix" }] } },
        { not: { or: [{ subject: "rechnung" }, { body: "rechnung" }] } },
      ],
    });
    expect(q.or).toBeUndefined();
    expect(page.messages).toEqual([{ id: "31" }, { id: "12" }]);

    const reported = (page.limitations ?? []).map((l) => `${l.constraint}:${l.handling}`);
    expect(reported).toContain("filenames:unsupported");
    expect(reported).toContain("hasAttachment:scanned");
    expect(reported).not.toContain("keywords:scanned");
  });

  it("sends one named keyword as a plain subject-or-body clause", async () => {
    state.searchResult = [1];
    await new ImapProvider(cfg()).search({
      keywords: ["rechnung"],
      dateFrom: new Date(),
      dateTo: new Date(),
    });
    const q = state.searchQuery as Record<string, unknown>;
    expect(q.or).toEqual([{ subject: "rechnung" }, { body: "rechnung" }]);
    expect(q.not).toBeUndefined();
  });

  it("sends an any-of group as one OR-clause over its words (#274)", async () => {
    state.searchResult = [1];
    await new ImapProvider(cfg()).search({
      anyOf: [["rechnung", "invoice"]],
      dateFrom: new Date(),
      dateTo: new Date(),
    });
    const q = state.searchQuery as Record<string, unknown>;
    expect(q.or).toEqual([
      { subject: "rechnung" },
      { body: "rechnung" },
      { subject: "invoice" },
      { body: "invoice" },
    ]);
    expect(q.not).toBeUndefined();
  });

  it("ANDs an any-of group with a named keyword", async () => {
    state.searchResult = [1];
    await new ImapProvider(cfg()).search({
      keywords: ["amazon"],
      anyOf: [["rechnung", "invoice"]],
      dateFrom: new Date(),
      dateTo: new Date(),
    });
    const q = state.searchQuery as Record<string, unknown>;
    expect(q.not).toEqual({
      or: [
        { not: { or: [{ subject: "amazon" }, { body: "amazon" }] } },
        {
          not: {
            or: [
              { subject: "rechnung" },
              { body: "rechnung" },
              { subject: "invoice" },
              { body: "invoice" },
            ],
          },
        },
      ],
    });
  });

  it("an any-of group alone is not widened by the invoice prefilter", async () => {
    state.searchResult = [1];
    await new ImapProvider({ ...cfg(), keywordPrefilter: true }).search({
      anyOf: [["beleg", "quittung"]],
      dateFrom: new Date(),
      dateTo: new Date(),
    });
    const q = state.searchQuery as Record<string, unknown>;
    expect(JSON.stringify(q)).not.toMatch(/"rechnung"/);
  });

  it("matches an any-of group in the local scan when the server rejects it", async () => {
    state.searchThrows = true;
    state.searchResult = [3, 2, 1];
    state.fetchList = [
      { uid: 3, envelope: { subject: "Your invoice", from: [{ address: "a@amazon.de" }] } },
      { uid: 2, envelope: { subject: "Ihre Rechnung", from: [{ address: "a@amazon.de" }] } },
      { uid: 1, envelope: { subject: "Newsletter", from: [{ address: "a@amazon.de" }] } },
    ];

    const page = await new ImapProvider(cfg()).search({
      keywords: ["amazon"],
      anyOf: [["rechnung", "invoice"]],
      dateFrom: new Date("2026-07-01T00:00:00Z"),
      dateTo: new Date("2026-07-31T00:00:00Z"),
    });

    expect(page.messages).toEqual([{ id: "3" }, { id: "2" }]);
    const reported = (page.limitations ?? []).map((l) => `${l.constraint}:${l.handling}`);
    expect(reported).toContain("anyOf:scanned");
  });

  it("falls back to a bounded local scan when the server rejects the keywords", async () => {
    // 260 messages in the window; the keyword search throws, so the scan walks
    // the newest MAX_IMAP_SCAN_MESSAGES of them and matches Subject/From itself.
    state.searchThrows = true;
    state.searchResult = Array.from({ length: 260 }, (_, i) => i + 1);
    state.fetchList = [
      {
        uid: 260,
        envelope: { subject: "Ihre Rechnung", from: [{ address: "billing@netflix.com" }] },
      },
      // Only one of the two keywords — a named search means both.
      { uid: 259, envelope: { subject: "Rechnung", from: [{ address: "billing@acme.example" }] } },
    ];

    const page = await new ImapProvider(cfg()).search({
      keywords: ["netflix", "rechnung"],
      dateFrom: new Date("2026-07-01T00:00:00Z"),
      dateTo: new Date("2026-07-31T00:00:00Z"),
    });

    // The second search is the window alone — no keyword keys left to reject.
    const q = state.searchQuery as Record<string, unknown>;
    expect(q.not).toBeUndefined();
    expect(q.or).toBeUndefined();

    expect((state.fetchRange as number[]).length).toBe(MAX_IMAP_SCAN_MESSAGES);
    expect((state.fetchRange as number[])[0]).toBe(260);
    expect(page.messages).toEqual([{ id: "260" }]);

    const reported = (page.limitations ?? []).map((l) => `${l.constraint}:${l.handling}`);
    // Both halves of the bound: the keywords were matched locally, and the
    // window held more than the scan reached.
    expect(reported).toContain("keywords:scanned");
    expect(reported).toContain("dateWindow:scanned");
  });

  it("reports every key the scan re-applied, not just the first", async () => {
    // A search naming keywords AND a sender has both re-applied locally when
    // the server rejects the query. Reporting only one left the other looking
    // server-side (#240 review).
    state.searchThrows = true;
    state.searchResult = [12];
    state.fetchList = [
      {
        uid: 12,
        envelope: { subject: "Rechnung", from: [{ address: "billing@netflix.com" }] },
      },
    ];

    const page = await new ImapProvider(cfg()).search({
      keywords: ["rechnung"],
      from: "netflix.com",
      dateFrom: new Date("2026-07-01T00:00:00Z"),
      dateTo: new Date("2026-07-31T00:00:00Z"),
    });

    const reported = (page.limitations ?? []).map((l) => `${l.constraint}:${l.handling}`);
    expect(reported).toContain("keywords:scanned");
    expect(reported).toContain("from:scanned");
    // And the report says which fields the local pass could actually read, so
    // the lost body match is not left implied by the scan bound alone.
    const scanned = (page.limitations ?? []).find((l) => l.constraint === "keywords");
    expect(scanned?.detail).toMatch(/Subject and From only/);
  });

  // ---- the attachment flag (#768) --------------------------------------------
  //
  // IMAP SEARCH cannot see attachments, so the provider reads BODYSTRUCTURE
  // itself before it cuts the page. Mail without one (notifications, threads
  // that mention "invoice") must not take the slots the receipt needs.
  it("fills the page with attachment-bearing messages only, newest first", async () => {
    // 30 matches: the newest 25 carry nothing, the next 5 a PDF.
    state.searchResult = Array.from({ length: 30 }, (_, i) => i + 1);
    for (let uid = 6; uid <= 30; uid++) state.structures[uid] = NO_ATTACHMENT;

    const page = await new ImapProvider(cfg()).search({
      keywords: ["github"],
      dateFrom: new Date("2026-07-01T00:00:00Z"),
      dateTo: new Date("2026-07-31T00:00:00Z"),
      limit: 20,
    });

    expect(page.messages).toEqual([
      { id: "5" },
      { id: "4" },
      { id: "3" },
      { id: "2" },
      { id: "1" },
    ]);
    expect(page.nextPageToken).toBeUndefined();
  });

  it("keeps only invoice-type attachments and says how it checked", async () => {
    state.searchResult = [3, 2, 1];
    state.structures = { 3: ZIP_ONLY, 2: PDF, 1: NO_ATTACHMENT };

    const page = await new ImapProvider(cfg()).search({
      dateFrom: new Date("2026-07-01T00:00:00Z"),
      dateTo: new Date("2026-07-31T00:00:00Z"),
    });

    expect(page.messages).toEqual([{ id: "2" }]);
    const flag = (page.limitations ?? []).find((l) => l.constraint === "hasAttachment");
    expect(flag?.handling).toBe("scanned");
    expect(flag?.detail).toMatch(/reads each match's BODYSTRUCTURE/);
    expect(flag?.detail).not.toMatch(/stopped/i);
  });

  it("leaves a search without the attachment flag as it was", async () => {
    // The HTML-invoice strategy and the header scan want mail with no
    // attachment, so nothing is checked and the page is cut as before.
    state.searchResult = Array.from({ length: 60 }, (_, i) => i + 1);
    state.defaultStructure = NO_ATTACHMENT;

    const page = await new ImapProvider(cfg()).search({
      keywords: [],
      hasAttachment: false,
      dateFrom: new Date("2026-07-01T00:00:00Z"),
      dateTo: new Date("2026-07-31T00:00:00Z"),
      limit: 20,
    });

    expect(state.structureFetches).toEqual([]);
    expect(page.messages).toHaveLength(20);
    expect(page.messages[0]).toEqual({ id: "60" });
    expect(page.nextPageToken).toBe("41");
    expect(page.limitations).toBeUndefined();
  });

  it("stops at a fixed bound, says so, and hands back a cursor below the last read", async () => {
    // 500 matches, none with an invoice attachment: an unbounded check would
    // read the whole window to fill one page.
    state.searchResult = Array.from({ length: 500 }, (_, i) => i + 1);
    state.defaultStructure = NO_ATTACHMENT;

    const page = await new ImapProvider(cfg()).search({
      dateFrom: new Date("2026-07-01T00:00:00Z"),
      dateTo: new Date("2026-07-31T00:00:00Z"),
      limit: 20,
    });

    const read = state.structureFetches.flat();
    expect(read.length).toBe(MAX_IMAP_ATTACHMENT_CHECKS);
    // Newest first: 500 down to the last one the bound allowed.
    expect(Math.max(...read)).toBe(500);
    const lowest = 500 - MAX_IMAP_ATTACHMENT_CHECKS + 1;
    expect(Math.min(...read)).toBe(lowest);

    expect(page.messages).toEqual([]);
    expect(page.nextPageToken).toBe(String(lowest));
    const flag = (page.limitations ?? []).find((l) => l.constraint === "hasAttachment");
    expect(flag?.detail).toMatch(/stopped/i);

    // The next page continues strictly below the cursor.
    state.structureFetches = [];
    await new ImapProvider(cfg()).search({
      dateFrom: new Date("2026-07-01T00:00:00Z"),
      dateTo: new Date("2026-07-31T00:00:00Z"),
      limit: 20,
      pageToken: page.nextPageToken,
    });
    expect(Math.max(...state.structureFetches.flat())).toBe(lowest - 1);
  });

  it("does not say it stopped when the page filled within the bound", async () => {
    state.searchResult = Array.from({ length: 500 }, (_, i) => i + 1);

    const page = await new ImapProvider(cfg()).search({
      dateFrom: new Date("2026-07-01T00:00:00Z"),
      dateTo: new Date("2026-07-31T00:00:00Z"),
      limit: 20,
    });

    expect(page.messages).toHaveLength(20);
    expect(page.nextPageToken).toBe("481");
    const flag = (page.limitations ?? []).find((l) => l.constraint === "hasAttachment");
    expect(flag?.detail).not.toMatch(/stopped/i);
  });

  it("returns an empty page when the server matches nothing", async () => {
    state.searchResult = false;
    const provider = new ImapProvider(cfg());
    const page = await provider.search({ dateFrom: new Date(), dateTo: new Date() });
    expect(page.messages).toEqual([]);
    expect(page.nextPageToken).toBeUndefined();
  });
});

// ---- getMessage -------------------------------------------------------------

describe("ImapProvider.getMessage", () => {
  it("walks BODYSTRUCTURE, keeps only invoice-type attachments, maps envelope", async () => {
    state.fetchResult = {
      uid: 42,
      internalDate: new Date("2025-03-15T09:00:00Z"),
      envelope: {
        subject: "Ihre Rechnung",
        messageId: "<abc@acme.example>",
        from: [{ name: "Acme GmbH", address: "billing@acme.example" }],
      },
      bodyStructure: {
        type: "multipart/mixed",
        childNodes: [
          { part: "1", type: "text/plain" },
          {
            part: "2",
            type: "application/pdf",
            disposition: "attachment",
            dispositionParameters: { filename: "invoice.pdf" },
            size: 1234,
          },
          // image with filename via content-type name, no explicit disposition
          {
            part: "3",
            type: "image/png",
            parameters: { name: "scan.png" },
            size: 555,
          },
          // non-invoice type is dropped
          {
            part: "4",
            type: "application/zip",
            disposition: "attachment",
            dispositionParameters: { filename: "extra.zip" },
            size: 10,
          },
        ],
      },
    };

    const provider = new ImapProvider(cfg());
    const msg = await provider.getMessage({ id: "42" });

    expect(msg.id).toBe("42");
    expect(msg.messageId).toBe("<abc@acme.example>");
    expect(msg.subject).toBe("Ihre Rechnung");
    expect(msg.from).toBe("Acme GmbH <billing@acme.example>");
    expect(msg.date).toEqual(new Date("2025-03-15T09:00:00Z"));

    expect(msg.attachments).toEqual([
      { attachmentId: "2", filename: "invoice.pdf", mimeType: "application/pdf", size: 1234 },
      { attachmentId: "3", filename: "scan.png", mimeType: "image/png", size: 555 },
    ]);
  });

  it("falls back to mailbox:uid when the message has no Message-ID", async () => {
    state.fetchResult = {
      uid: 7,
      internalDate: new Date("2025-01-01T00:00:00Z"),
      envelope: { subject: "no id", from: [{ address: "a@b.c" }] },
      bodyStructure: { type: "text/plain" },
    };
    const provider = new ImapProvider(cfg({ mailbox: "Archive" }));
    const msg = await provider.getMessage({ id: "7" });
    expect(msg.messageId).toBe("Archive:7");
    expect(msg.from).toBe("a@b.c");
    expect(msg.attachments).toEqual([]);
  });

  it("throws when the UID is not found", async () => {
    state.fetchResult = false;
    const provider = new ImapProvider(cfg());
    await expect(provider.getMessage({ id: "99" })).rejects.toThrow(/not found/i);
  });
});

// ---- getAttachment ----------------------------------------------------------

describe("ImapProvider.getAttachment", () => {
  it("downloads the bodystructure part and buffers the stream", async () => {
    state.downloadBuffer = Buffer.from("%PDF-1.7 bytes");
    const provider = new ImapProvider(cfg());
    const buf = await provider.getAttachment(
      { id: "42", messageId: null, from: "", subject: "", date: new Date(), attachments: [] },
      { attachmentId: "2", filename: "invoice.pdf", mimeType: "application/pdf", size: 3 }
    );
    expect(state.downloadPart).toBe("2");
    expect(buf.toString()).toBe("%PDF-1.7 bytes");
  });
});

// ---- getBody (#245) ---------------------------------------------------------

describe("ImapProvider.getBody", () => {
  it("reads the HTML and plain-text body parts, never an attachment", async () => {
    state.fetchResult = {
      uid: 42,
      bodyStructure: {
        type: "multipart/mixed",
        childNodes: [
          {
            type: "multipart/alternative",
            childNodes: [
              { part: "1.1", type: "text/plain", size: 10 },
              { part: "1.2", type: "text/html", size: 20 },
            ],
          },
          {
            part: "2",
            type: "text/html",
            disposition: "attachment",
            dispositionParameters: { filename: "terms.html" },
          },
        ],
      },
    };
    state.downloadBuffers = {
      "1.1": Buffer.from("Rechnung 12,00"),
      "1.2": Buffer.from("<p>Rechnung 12,00</p>"),
    };

    const provider = new ImapProvider(cfg());
    const body = await provider.getBody({ id: "42" });

    expect(body).toEqual({ html: "<p>Rechnung 12,00</p>", text: "Rechnung 12,00" });
    expect(state.downloadParts.sort()).toEqual(["1.1", "1.2"]);
  });

  it("reads a single-part plain message as part 1", async () => {
    state.fetchResult = { uid: 7, bodyStructure: { type: "text/plain", size: 5 } };
    state.downloadBuffers = { "1": Buffer.from("hello") };

    const provider = new ImapProvider(cfg());
    const body = await provider.getBody({ id: "7" });

    expect(body).toEqual({ html: null, text: "hello" });
  });

  it("throws when the message is gone", async () => {
    state.fetchResult = null;
    const provider = new ImapProvider(cfg());
    await expect(provider.getBody({ id: "9" })).rejects.toThrow(/not found/);
  });
});

// ---- connection / factory ---------------------------------------------------

describe("ImapProvider connection + factory", () => {
  it("passes rejectUnauthorized:false only when allowSelfSigned is set", async () => {
    state.searchResult = [];
    await new ImapProvider(cfg({ allowSelfSigned: true })).search({
      dateFrom: new Date(),
      dateTo: new Date(),
    });
    expect((state.ctorOpts as { tls?: { rejectUnauthorized: boolean } }).tls).toEqual({
      rejectUnauthorized: false,
    });

    state.ctorOpts = null;
    await new ImapProvider(cfg({ allowSelfSigned: false })).search({
      dateFrom: new Date(),
      dateTo: new Date(),
    });
    expect((state.ctorOpts as { tls?: unknown }).tls).toBeUndefined();
  });

  it("logs out on close", async () => {
    state.searchResult = [];
    const provider = new ImapProvider(cfg());
    await provider.search({ dateFrom: new Date(), dateTo: new Date() });
    await provider.close();
    expect(state.loggedOut).toBe(true);
  });

  it("makeProvider('imap') builds an ImapProvider and requires config", () => {
    expect(makeProvider("imap", { imap: cfg() })).toBeInstanceOf(ImapProvider);
    expect(() => makeProvider("imap", {})).toThrow(/config/i);
  });
});
