/**
 * #746: the receipt search reads every Mail Integration through its Mail
 * Provider, Gmail and IMAP alike.
 *
 * Drives the real import handler and the real search queue, as
 * search-gmail-only.test.ts did before it. A Gmail mailbox is the real
 * GmailProvider over a stubbed Gmail API (`fetch`), so the Gmail case
 * characterises what a cloud User gets; it was recorded against the search
 * before its email strategies moved onto the Mail Provider interface.
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

/** Import one bank line through the real handler and run the search it queues. */
async function importCharge(): Promise<string> {
  const created = await bulkCreateTransactionsCallable.run({
    data: {
      sourceId: "src-n26",
      transactions: [
        {
          sourceId: "src-n26",
          date: "2026-07-20T12:00:00.000Z",
          amount: -4900,
          currency: "EUR",
          name: "ACME HOSTING GMBH",
          partner: "Acme Hosting GmbH",
          dedupeHash: "hash-1",
          importJobId: "job-1",
          csvRowIndex: 0,
          _original: { rawRow: {} },
        },
      ],
    },
    auth: AUTH,
  } as never);
  const transactionId = created.transactionIds[0] as string;

  await createImportRecordCallable.run({
    data: {
      importJobId: "job-1",
      sourceId: "src-n26",
      fileName: "n26.csv",
      importedCount: 1,
      skippedCount: 0,
      errorCount: 0,
      totalRows: 1,
    },
    auth: AUTH,
  } as never);
  await drainTriggers();
  await __whenShimIdle();
  return transactionId;
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
      nominated: f.precisionSearchHint?.transactionId ?? null,
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
