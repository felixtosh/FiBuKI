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
    fetchResult: null as unknown,
    downloadPart: null as string | null,
    downloadBuffer: Buffer.from("PDFDATA"),
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
    async *fetch(range: unknown) {
      state.fetchRange = range;
      for (const msg of state.fetchList) yield msg;
    }
    async fetchOne() {
      return state.fetchResult;
    }
    async download(range: string, part: string) {
      state.downloadPart = part;
      return { meta: {}, content: Readable.from([state.downloadBuffer]) };
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
import { MAX_IMAP_SCAN_MESSAGES } from "../constants";

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
  state.fetchResult = null;
  state.downloadPart = null;
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
