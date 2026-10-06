/**
 * #746: the receipt search reads every Mail Integration through its Mail
 * Provider, Gmail and IMAP alike.
 *
 * Drives the real import handler and the real search queue, as
 * local-file-nomination.test.ts does. A Gmail mailbox is the real
 * GmailProvider over a stubbed Gmail API (`fetch`), so the Gmail case
 * characterises what a cloud User gets; it was recorded against the search
 * before its email strategies moved onto the Mail Provider interface. An IMAP
 * mailbox is a fake Mail Provider handed out by the factory the search opens
 * mailboxes through; no IMAP server runs.
 *
 * Supersedes search-gmail-only.test.ts (#680), whose rule (search Gmail only,
 * never pause for IMAP) this ticket reverses.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";

// REAL application code, unmodified:
import "../matching/matchFilePartner";
import "../matching/matchFileTransactions";
import "../gmail/onTransactionsImported";
import "../precision-search/precisionSearchQueue";
import { bulkCreateTransactionsCallable } from "../imports/bulkCreateTransactions";
import { createImportRecordCallable } from "../imports/createImportRecord";
import { queueIncompleteTransactionSearch } from "../precision-search/queueIncompleteSearch";
import { __setMailProviderFactory } from "../mail/searchMailboxes";
import type {
  MailAttachment,
  MailBody,
  MailMessage,
  MailMessageRef,
  MailProvider,
  MailSearchOptions,
  MailSearchPage,
} from "../mail/provider";

process.env.FIBUKI_STORAGE = "memory";

const db = getFirestore();
const USER = "stefan-test";
const AUTH = { uid: USER };

const PDF = Buffer.from("%PDF-1.4 acme invoice 49.00");

async function seedBase() {
  await db.collection("subscriptions").doc(USER).set({
    userId: USER,
    automationMode: "active",
    planId: "free",
  });
  await db.collection("sources").doc("src-n26").set({
    userId: USER,
    name: "N26 Business",
    iban: "DE89370400440532013000",
    currency: "EUR",
    type: "manual",
    isActive: true,
  });
}

/** A Gmail mailbox with a token that is still valid, so no refresh is needed. */
async function gmailMailbox(id: string) {
  await db.collection("emailIntegrations").doc(id).set({
    userId: USER,
    provider: "gmail",
    email: `${id}@example.com`,
    isActive: true,
    needsReauth: false,
    initialSyncComplete: true,
    createdAt: Timestamp.fromDate(new Date("2026-01-01T00:00:00.000Z")),
  });
  await db.collection("emailTokens").doc(id).set({
    accessToken: "valid-token",
    refreshToken: "refresh-token",
    expiresAt: Timestamp.fromDate(new Date(Date.now() + 60 * 60 * 1000)),
  });
}

interface StubMessage {
  id: string;
  from: string;
  subject: string;
  date: string;
  attachment?: { id: string; filename: string; mimeType: string; data: Buffer };
}

/**
 * The Gmail API as far as the search reads it: every search returns every
 * message (Gmail's own ranking is not what is under test), a message is
 * returned in `format=full`, an attachment as base64url.
 */
function stubGmailApi(messages: StubMessage[]) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  const fetchStub = vi.fn(async (input: string | URL) => {
    const url = new URL(String(input));
    if (url.host !== "gmail.googleapis.com") {
      return new Response("not stubbed", { status: 503 });
    }
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

    const attachment = url.pathname.match(/\/messages\/([^/]+)\/attachments\/([^/]+)$/);
    if (attachment) {
      const message = byId.get(attachment[1]);
      if (!message?.attachment || message.attachment.id !== attachment[2]) {
        return new Response("not found", { status: 404 });
      }
      return json({ data: message.attachment.data.toString("base64url"), size: message.attachment.data.length });
    }

    const single = url.pathname.match(/\/messages\/([^/]+)$/);
    if (single) {
      const message = byId.get(single[1]);
      if (!message) return new Response("not found", { status: 404 });
      return json({
        id: message.id,
        threadId: message.id,
        internalDate: String(new Date(message.date).getTime()),
        snippet: message.subject,
        payload: {
          mimeType: "multipart/mixed",
          headers: [
            { name: "From", value: message.from },
            { name: "Subject", value: message.subject },
            { name: "Message-ID", value: `<${message.id}@mail.example>` },
          ],
          parts: [
            {
              partId: "0",
              mimeType: "text/plain",
              filename: "",
              body: { size: 10, data: Buffer.from("Anbei Ihre Rechnung").toString("base64url") },
            },
            ...(message.attachment
              ? [
                  {
                    partId: "1",
                    mimeType: message.attachment.mimeType,
                    filename: message.attachment.filename,
                    body: { attachmentId: message.attachment.id, size: message.attachment.data.length },
                  },
                ]
              : []),
          ],
        },
      });
    }

    if (url.pathname.endsWith("/messages")) {
      return json({ messages: messages.map((m) => ({ id: m.id, threadId: m.id })), resultSizeEstimate: messages.length });
    }
    return new Response("not stubbed", { status: 503 });
  });
  vi.stubGlobal("fetch", fetchStub);
  return fetchStub;
}

interface Charge {
  date: string;
  amount: number;
  name: string;
}

const ACME: Charge = { date: "2026-07-20T12:00:00.000Z", amount: -4900, name: "ACME HOSTING GMBH" };

let importCount = 0;

/** Import bank lines through the real handler and run the search it queues. */
async function importCharges(charges: Charge[] = [ACME]): Promise<string[]> {
  const job = `job-${++importCount}`;
  const created = await bulkCreateTransactionsCallable.run({
    data: {
      sourceId: "src-n26",
      transactions: charges.map((charge, i) => ({
        sourceId: "src-n26",
        date: charge.date,
        amount: charge.amount,
        currency: "EUR",
        name: charge.name,
        partner: charge.name,
        dedupeHash: `${job}-hash-${i}`,
        importJobId: job,
        csvRowIndex: i,
        _original: { rawRow: {} },
      })),
    },
    auth: AUTH,
  } as never);

  await createImportRecordCallable.run({
    data: {
      importJobId: job,
      sourceId: "src-n26",
      fileName: "n26.csv",
      importedCount: charges.length,
      skippedCount: 0,
      errorCount: 0,
      totalRows: charges.length,
    },
    auth: AUTH,
  } as never);
  await drainTriggers();
  await __whenShimIdle();
  return created.transactionIds as string[];
}

async function importCharge(): Promise<string> {
  return (await importCharges([ACME]))[0];
}

async function mailFiles() {
  const snap = await db.collection("files").where("userId", "==", USER).get();
  return snap.docs
    .map((d) => d.data()!)
    .filter((f) => f.mailMessageId)
    .map((f) => ({
      sourceType: f.sourceType,
      mailbox: f.gmailIntegrationId,
      message: f.mailMessageId,
      attachment: f.mailAttachmentId,
      nominated: (f.precisionSearchHint as { transactionId?: string } | undefined)?.transactionId ?? null,
    }));
}

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
  await seedBase();
});

afterEach(() => {
  vi.unstubAllGlobals();
  __setMailProviderFactory(null);
});

describe("#746: the receipt search over a Gmail Mail Integration (characterisation)", () => {
  it("files the in-window invoice attachment once and nominates the Transaction", async () => {
    await gmailMailbox("gmail-1");
    stubGmailApi([
      {
        id: "msg-july",
        from: "Acme Hosting <billing@acme-hosting.example>",
        subject: "Ihre Rechnung Juli",
        date: "2026-07-18T08:00:00.000Z",
        attachment: { id: "att-july", filename: "rechnung-juli.pdf", mimeType: "application/pdf", data: PDF },
      },
      {
        // Outside ±180 days of the charge: never filed.
        id: "msg-old",
        from: "Acme Hosting <billing@acme-hosting.example>",
        subject: "Ihre Rechnung",
        date: "2025-06-01T08:00:00.000Z",
        attachment: {
          id: "att-old",
          filename: "rechnung-alt.pdf",
          mimeType: "application/pdf",
          data: Buffer.from("%PDF-1.4 old"),
        },
      },
    ]);

    const transactionId = await importCharge();

    expect(await mailFiles()).toEqual([
      {
        sourceType: "gmail",
        mailbox: "gmail-1",
        message: "msg-july",
        attachment: "att-july",
        nominated: transactionId,
      },
    ]);
  });
});

// ============================================================================
// IMAP (#746)
// ============================================================================

/** An IMAP mailbox as its Mail Integration and token record store it. */
async function imapMailbox(
  id: string,
  opts: { needsReauth?: boolean; createdAt?: string } = {}
) {
  await db.collection("emailIntegrations").doc(id).set({
    userId: USER,
    provider: "imap",
    email: `${id}@example.com`,
    isActive: true,
    needsReauth: opts.needsReauth ?? false,
    initialSyncComplete: true,
    imapHost: "imap.example.com",
    imapPort: 993,
    createdAt: Timestamp.fromDate(new Date(opts.createdAt ?? "2026-02-01T00:00:00.000Z")),
  });
  await db.collection("emailTokens").doc(id).set({
    integrationId: id,
    userId: USER,
    provider: "imap",
    secret: "cipher",
    secretIv: "iv",
    updatedAt: Timestamp.now(),
  });
}

interface FakeMail {
  uid: string;
  from: string;
  subject: string;
  date: string;
  attachment?: { part: string; filename: string; mimeType?: string; data: Buffer };
}

/**
 * An IMAP mailbox: every search returns its messages in the window, newest
 * first, and reports the attachment flag as scanned, as ImapProvider does.
 */
class FakeImapMailbox implements MailProvider {
  searches = 0;
  closed = 0;
  constructor(
    private readonly mail: FakeMail[],
    private readonly failWith?: Error
  ) {}

  async search(opts: MailSearchOptions): Promise<MailSearchPage> {
    this.searches++;
    if (this.failWith) throw this.failWith;
    const inWindow = this.mail
      .filter((m) => {
        const t = new Date(m.date).getTime();
        return t >= opts.dateFrom.getTime() && t <= opts.dateTo.getTime() + 24 * 60 * 60 * 1000;
      })
      .sort((a, b) => b.date.localeCompare(a.date));
    return {
      messages: inWindow.map((m) => ({ id: m.uid })),
      limitations: [
        {
          constraint: "hasAttachment",
          handling: "scanned",
          detail: "IMAP SEARCH cannot see attachments; messages are filtered on BODYSTRUCTURE after they are fetched.",
        },
      ],
    };
  }

  private find(ref: MailMessageRef): FakeMail {
    const found = this.mail.find((m) => m.uid === ref.id);
    if (!found) throw new Error(`IMAP message not found for UID ${ref.id}`);
    return found;
  }

  async getMessage(ref: MailMessageRef): Promise<MailMessage> {
    const m = this.find(ref);
    return {
      id: m.uid,
      messageId: `<${m.uid}@imap.example>`,
      from: m.from,
      subject: m.subject,
      date: new Date(m.date),
      attachments: m.attachment
        ? [
            {
              attachmentId: m.attachment.part,
              filename: m.attachment.filename,
              mimeType: m.attachment.mimeType ?? "application/pdf",
              size: m.attachment.data.length,
            },
          ]
        : [],
    };
  }

  async getAttachment(message: MailMessage, attachment: MailAttachment): Promise<Buffer> {
    const m = this.find({ id: message.id });
    if (!m.attachment || m.attachment.part !== attachment.attachmentId) throw new Error("no such part");
    return m.attachment.data;
  }

  async getBody(): Promise<MailBody> {
    return { html: null, text: "Anbei Ihre Rechnung" };
  }

  async close(): Promise<void> {
    this.closed++;
  }
}

/** Stand fake mailboxes in for the IMAP ones; Gmail keeps its real provider. */
function useFakeImap(mailboxes: Record<string, FakeImapMailbox>) {
  const opened: string[] = [];
  __setMailProviderFactory(async (integrationId, integration) => {
    if (integration.provider !== "imap") return null;
    opened.push(integrationId);
    const mailbox = mailboxes[integrationId];
    if (!mailbox) throw new Error(`no fake for ${integrationId}`);
    return mailbox;
  });
  return { opened };
}

const ACME_JULY: FakeMail = {
  uid: "4711",
  from: "Acme Hosting <billing@acme-hosting.example>",
  subject: "Ihre Rechnung Juli",
  date: "2026-07-18T08:00:00.000Z",
  attachment: { part: "2", filename: "rechnung-juli.pdf", data: PDF },
};

async function integration(id: string) {
  return (await db.collection("emailIntegrations").doc(id).get()).data()!;
}

async function queueItems() {
  return (await db.collection("precisionSearchQueue").get()).docs.map((d) => d.data()!);
}

async function attemptsOf(transactionId: string) {
  const searches = await db.collection("transactions").doc(transactionId).collection("searches").get();
  expect(searches.docs).toHaveLength(1);
  return searches.docs[0].data()!.attempts as Array<{
    strategy: string;
    error?: string;
    mailLimitations?: Array<{ integrationId: string; constraint: string; handling: string }>;
  }>;
}

describe("#746: the receipt search reads IMAP Mail Integrations", () => {
  it("files an invoice attachment from an IMAP mailbox and nominates the Transaction", async () => {
    await imapMailbox("imap-1");
    const mailbox = new FakeImapMailbox([ACME_JULY]);
    useFakeImap({ "imap-1": mailbox });

    const transactionId = await importCharge();

    expect(await mailFiles()).toEqual([
      { sourceType: "gmail", mailbox: "imap-1", message: "4711", attachment: "2", nominated: transactionId },
    ]);
    const attempts = await attemptsOf(transactionId);
    expect(attempts.map((a) => a.strategy)).toEqual(
      expect.arrayContaining(["email_attachment", "email_invoice"])
    );
    expect(attempts.filter((a) => a.error)).toEqual([]);
    // What the IMAP server could not do is reported, not dropped.
    const limitations = attempts.find((a) => a.strategy === "email_attachment")!.mailLimitations;
    expect(limitations).toEqual([expect.objectContaining({ integrationId: "imap-1", constraint: "hasAttachment", handling: "scanned" })]);
    expect(mailbox.closed).toBe(1);
  });

  it("records the search on the Mail Integration for the mailbox page", async () => {
    await imapMailbox("imap-1");
    useFakeImap({ "imap-1": new FakeImapMailbox([ACME_JULY]) });

    await importCharge();

    const record = await integration("imap-1");
    expect(record.receiptSearchLastSearchedAt).toBeTruthy();
    expect(record.receiptSearchFilesCreated).toBe(1);
    expect(record.receiptSearchLastError ?? null).toBeNull();
  });

  it("searches an IMAP and a Gmail Mail Integration for the same Transaction", async () => {
    await imapMailbox("imap-1");
    await gmailMailbox("gmail-1");
    useFakeImap({ "imap-1": new FakeImapMailbox([ACME_JULY]) });
    stubGmailApi([
      {
        id: "msg-gmail",
        from: "Acme Hosting <billing@acme-hosting.example>",
        subject: "Ihre Rechnung Juli (Kopie)",
        date: "2026-07-19T08:00:00.000Z",
        attachment: {
          id: "att-gmail",
          filename: "rechnung-kopie.pdf",
          mimeType: "application/pdf",
          data: Buffer.from("%PDF-1.4 acme copy 49.00"),
        },
      },
    ]);

    const transactionId = await importCharge();

    const files = await mailFiles();
    expect(files.map((f) => f.mailbox).sort()).toEqual(["gmail-1", "imap-1"]);
    expect(files.every((f) => f.nominated === transactionId)).toBe(true);
  });

  it("marks only the IMAP mailbox whose login is refused as needing new credentials, and searches the other", async () => {
    await imapMailbox("imap-broken", { createdAt: "2026-01-01T00:00:00.000Z" });
    await imapMailbox("imap-ok", { createdAt: "2026-02-01T00:00:00.000Z" });
    const refused = Object.assign(new Error("Command failed"), {
      authenticationFailed: true,
      responseText: "AUTHENTICATIONFAILED Invalid credentials",
    });
    useFakeImap({
      "imap-broken": new FakeImapMailbox([], refused),
      "imap-ok": new FakeImapMailbox([ACME_JULY]),
    });

    const transactionId = await importCharge();

    expect(await mailFiles()).toEqual([
      { sourceType: "gmail", mailbox: "imap-ok", message: "4711", attachment: "2", nominated: transactionId },
    ]);
    const broken = await integration("imap-broken");
    expect(broken.needsReauth).toBe(true);
    expect(broken.lastSyncErrorCode).toBe("auth_failed");
    expect(broken.receiptSearchLastError).toMatch(/Authentication failed/);
    expect(broken.receiptSearchLastErrorAt).toBeTruthy();
    const ok = await integration("imap-ok");
    expect(ok.needsReauth).toBe(false);
    expect(ok.receiptSearchFilesCreated).toBe(1);
  });

  it("creates one File when two searches find the same attachment", async () => {
    await imapMailbox("imap-1");
    useFakeImap({ "imap-1": new FakeImapMailbox([ACME_JULY]) });

    await importCharge();
    await queueIncompleteTransactionSearch(db as never, USER, "manual");
    await drainTriggers();
    await __whenShimIdle();

    expect(await mailFiles()).toHaveLength(1);
    expect((await integration("imap-1")).receiptSearchFilesCreated).toBe(1);
  });

  it("does not take one mailbox's message for another's: an IMAP UID is unique only within its mailbox", async () => {
    await imapMailbox("imap-1");
    await imapMailbox("imap-2");
    useFakeImap({
      "imap-1": new FakeImapMailbox([ACME_JULY]),
      // Same UID and part number, a different invoice.
      "imap-2": new FakeImapMailbox([
        { ...ACME_JULY, attachment: { ...ACME_JULY.attachment!, data: Buffer.from("%PDF-1.4 other mailbox") } },
      ]),
    });

    await importCharge();

    expect((await mailFiles()).map((f) => f.mailbox).sort()).toEqual(["imap-1", "imap-2"]);
  });

  it("opens each mailbox once for an Import, however many lines it has", async () => {
    await imapMailbox("imap-1");
    const mailbox = new FakeImapMailbox([ACME_JULY]);
    const { opened } = useFakeImap({ "imap-1": mailbox });

    await importCharges([
      ACME,
      { date: "2026-07-21T12:00:00.000Z", amount: -1200, name: "BETA TOOLS GMBH" },
      { date: "2026-07-22T12:00:00.000Z", amount: -800, name: "GAMMA CLOUD AG" },
    ]);

    expect(opened).toEqual(["imap-1"]);
    expect(mailbox.searches).toBeGreaterThan(3);
    expect(mailbox.closed).toBe(1);
  });

  it("pauses the search while an IMAP mailbox waits for new credentials", async () => {
    await imapMailbox("imap-1");
    await imapMailbox("imap-2", { needsReauth: true });
    useFakeImap({ "imap-1": new FakeImapMailbox([ACME_JULY]) });

    await importCharge();

    const items = await queueItems();
    expect(items.map((q) => q.status)).toEqual(["pending"]);
    expect(items[0].lastError).toMatch(/mailbox needs new credentials/);
    expect(await mailFiles()).toEqual([]);
  });
});
