/**
 * #103 option C: the mail header scan turns new mail headers into
 * per-Transaction receipt searches, and nothing else. Run against the real
 * Postgres-backed shim with an in-memory mailbox.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import type { MailMessage, MailProvider, MailSearchOptions } from "../mail/provider";
import {
  HEADER_SCAN_CURSOR,
  HEADER_SCAN_MAX_SEARCHES_PER_USER,
  hasInvoiceKeyword,
  scanMailHeaders,
  senderDomains,
} from "../precision-search/mailHeaderScan";

const db = getFirestore();
const USER = "u1";
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-09-30T12:15:00+02:00");

function daysAgo(n: number): Date {
  return new Date(NOW.getTime() - n * DAY);
}

/** An in-memory mailbox that answers search by date window and headers by id. */
function mailbox(messages: MailMessage[]) {
  const searches: MailSearchOptions[] = [];
  const provider: MailProvider = {
    async search(opts) {
      searches.push(opts);
      const hits = messages.filter((m) => m.date >= opts.dateFrom && m.date <= opts.dateTo);
      return { messages: hits.map((m) => ({ id: m.id })) };
    },
    async getMessage(ref) {
      return messages.find((m) => m.id === ref.id)!;
    },
    async getAttachment() {
      throw new Error("the header scan must never fetch an attachment");
    },
    async close() {},
  };
  return { provider, searches };
}

function mail(id: string, from: string, subject: string, ageDays: number): MailMessage {
  return { id, messageId: null, from, subject, date: daysAgo(ageDays), attachments: [] };
}

async function integration(id = "g1", extra: Record<string, unknown> = {}) {
  await db.collection("emailIntegrations").doc(id).set({
    userId: USER,
    provider: "gmail",
    email: "felix@example.com",
    isActive: true,
    needsReauth: false,
    ...extra,
  });
}

async function partner(id: string, domains: string[]) {
  await db.collection("partners").doc(id).set({ userId: USER, name: id, isActive: true, emailDomains: domains });
}

async function tx(id: string, partnerId: string | null, ageDays: number, extra: Record<string, unknown> = {}) {
  await db.collection("transactions").doc(id).set({
    userId: USER,
    partnerId,
    amount: -2500,
    date: Timestamp.fromDate(daysAgo(ageDays)),
    isComplete: false,
    fileIds: [],
    ...extra,
  });
}

let searched: Array<{ transactionId: string; partnerId?: string }>;
function deps(provider: MailProvider) {
  return {
    now: NOW,
    providerFor: async () => provider,
    queueSearch: vi.fn(async (args: { transactionId: string; partnerId?: string }) => {
      searched.push(args);
    }),
  };
}

beforeEach(async () => {
  await __resetFirestoreShim();
  searched = [];
});

describe("senderDomains", () => {
  it("reads the address out of a display-name From header", () => {
    expect(senderDomains('"Amazon.de" <shipment-tracking@amazon.de>')).toEqual(["amazon.de"]);
  });

  it("also tries the registrable domain under a subdomain", () => {
    expect(senderDomains("billing@invoices.magenta.at")).toEqual(["invoices.magenta.at", "magenta.at"]);
  });

  it("gives nothing for a header without an address", () => {
    expect(senderDomains("Mailer-Daemon")).toEqual([]);
  });
});

describe("hasInvoiceKeyword", () => {
  it("matches German and English wordings, case-insensitively", () => {
    expect(hasInvoiceKeyword("Ihre Rechnung Nr. 4711")).toBe(true);
    expect(hasInvoiceKeyword("Your invoice is ready")).toBe(true);
    expect(hasInvoiceKeyword("Zahlungsbestätigung")).toBe(true);
  });

  it("ignores newsletters", () => {
    expect(hasInvoiceKeyword("10 Tipps für den Herbst")).toBe(false);
  });
});

describe("scanMailHeaders", () => {
  it("points the receipt search at a known Partner's open Transaction shortly before the mail", async () => {
    await integration();
    await partner("amazon", ["amazon.de"]);
    await tx("t-open", "amazon", 3);
    await tx("t-documented", "amazon", 3, { fileIds: ["f1"] });
    await tx("t-too-old", "amazon", 30);
    const { provider } = mailbox([mail("m1", "Amazon.de <auto-shipping@amazon.de>", "Ihre Bestellung", 1)]);

    const report = await scanMailHeaders(deps(provider));

    expect(report).toMatchObject({ mailboxes: 1, headers: 1, knownSenderHits: 1, keywordHits: 0, searches: 1, errors: 0 });
    expect(searched).toEqual([{ transactionId: "t-open", userId: USER, partnerId: "amazon" }]);
  });

  it("uses an invoice keyword to tie an unknown sender's mail to the closest open Transactions", async () => {
    await integration();
    await tx("t-close", null, 2);
    await tx("t-closer", null, 1);
    await tx("t-far", null, 20);
    const { provider } = mailbox([mail("m1", "billing@newvendor.example", "Rechnung 2026-0815", 1)]);

    const report = await scanMailHeaders(deps(provider));

    expect(report.keywordHits).toBe(1);
    expect(searched.map((s) => s.transactionId).sort()).toEqual(["t-close", "t-closer"]);
  });

  it("ignores mail from an unknown sender without an invoice keyword", async () => {
    await integration();
    await tx("t-open", null, 1);
    const { provider } = mailbox([mail("m1", "news@newsletter.example", "Herbstangebote", 1)]);

    const report = await scanMailHeaders(deps(provider));

    expect(report.searches).toBe(0);
    expect(searched).toEqual([]);
  });

  it("reads only mail since the last scan and advances the cursor", async () => {
    await integration("g1", { [HEADER_SCAN_CURSOR]: Timestamp.fromDate(daysAgo(2)) });
    await partner("amazon", ["amazon.de"]);
    await tx("t-open", "amazon", 3);
    const { provider, searches } = mailbox([
      mail("m-old", "x@amazon.de", "Alt", 5),
      mail("m-new", "x@amazon.de", "Neu", 1),
    ]);

    const report = await scanMailHeaders(deps(provider));

    expect(searches[0].dateFrom.getTime()).toBe(daysAgo(2).getTime());
    expect(report.headers).toBe(1);
    const after = (await db.collection("emailIntegrations").doc("g1").get()).data()!;
    expect(after[HEADER_SCAN_CURSOR].toDate().getTime()).toBe(NOW.getTime());
  });

  it("looks back one day on a mailbox never scanned", async () => {
    await integration();
    const { provider, searches } = mailbox([]);
    await scanMailHeaders(deps(provider));
    expect(searches[0].dateFrom.getTime()).toBe(NOW.getTime() - DAY);
  });

  it("never asks for attachments or a keyword sweep", async () => {
    await integration();
    const { provider, searches } = mailbox([]);
    await scanMailHeaders(deps(provider));
    expect(searches[0]).toMatchObject({ keywords: [], hasAttachment: false });
  });

  it("skips a mailbox that needs re-authentication and a user in passive mode", async () => {
    await integration("g-reauth", { needsReauth: true });
    await integration("g-passive");
    await db.collection("subscriptions").doc(USER).set({ automationMode: "passive" });
    const { provider } = mailbox([mail("m1", "x@amazon.de", "Rechnung", 1)]);

    const report = await scanMailHeaders(deps(provider));

    expect(report.mailboxes).toBe(0);
  });

  it("keeps the cursor when a mailbox fails, so the window is read again", async () => {
    await integration();
    const broken: MailProvider = {
      async search() {
        throw new Error("IMAP down");
      },
      async getMessage() {
        throw new Error("unreachable");
      },
      async getAttachment() {
        throw new Error("unreachable");
      },
      async close() {},
    };

    const report = await scanMailHeaders(deps(broken));

    expect(report.errors).toBe(1);
    const after = (await db.collection("emailIntegrations").doc("g1").get()).data()!;
    expect(after[HEADER_SCAN_CURSOR]).toBeUndefined();
  });

  it("bounds the searches per user per scan", async () => {
    await integration();
    await partner("amazon", ["amazon.de"]);
    for (let i = 0; i < HEADER_SCAN_MAX_SEARCHES_PER_USER + 5; i++) {
      await tx(`t-${i}`, "amazon", 2);
    }
    const { provider } = mailbox([mail("m1", "x@amazon.de", "Bestellung", 1)]);

    const report = await scanMailHeaders(deps(provider));

    expect(report.searches).toBe(HEADER_SCAN_MAX_SEARCHES_PER_USER);
  });
});
