/**
 * Work item 5 — storage shim (memory backend) semantics + real handlers.
 *
 * Two layers:
 *  1. Surface semantics the call sites depend on: GCS-shaped metadata
 *     (string size, custom metadata under metadata.metadata, both save()
 *     option spellings), setMetadata merge, 404-coded errors, getFiles
 *     prefix listing, unconfigured-backend loud failure.
 *  2. REAL application code, unmodified: deleteDraftImport callable
 *     (storage delete inside a callable) and the full testInboundEmail
 *     onRequest flow (attachment → storage save + makePublic → files doc
 *     → inbound log → address stats).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getFirestore, __resetFirestoreShim } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";
import { getStorage, _resetStorageForTests } from "./storage-shim";

// REAL application code, unmodified:
import { deleteDraftImportCallable } from "../imports/deleteDraftImport";
import { testInboundEmail } from "../email-inbound/receiveEmail";

const db = getFirestore();
const USER = "stefan-test";

beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 20));
  await __resetFirestoreShim();
  __resetTriggerShim();
  process.env.FIBUKI_STORAGE = "memory";
  _resetStorageForTests();
});

afterEach(() => {
  delete process.env.FIBUKI_STORAGE;
  delete process.env.FUNCTIONS_EMULATOR;
  _resetStorageForTests();
});

const bucket = () => getStorage().bucket();

describe("storage shim surface semantics (memory backend)", () => {
  it("save/download roundtrip with top-level contentType (tools/handlers shape)", async () => {
    const file = bucket().file("files/u1/a.pdf");
    await file.save(Buffer.from("pdf-bytes"), {
      contentType: "application/pdf",
      metadata: { metadata: { userId: "u1", firebaseStorageDownloadTokens: "tok-1" } },
    });

    const [exists] = await file.exists();
    expect(exists).toBe(true);

    const [data] = await file.download();
    expect(data.toString()).toBe("pdf-bytes");

    const [meta] = await file.getMetadata();
    expect(meta.contentType).toBe("application/pdf");
    expect(meta.size).toBe("9"); // string, call sites parseInt it
    expect(meta.metadata?.firebaseStorageDownloadTokens).toBe("tok-1");
  });

  it("normalizes the nested gmailSyncQueue save shape (contentType inside metadata)", async () => {
    const file = bucket().file("files/u1/gmail-att.png");
    await file.save(Buffer.from("png"), {
      metadata: {
        contentType: "image/png",
        contentDisposition: "inline",
        metadata: { originalFilename: "Rechnung Juli.png", gmailMessageId: "m-1" },
      },
    });

    const [meta] = await file.getMetadata();
    expect(meta.contentType).toBe("image/png");
    expect(meta.contentDisposition).toBe("inline");
    expect(meta.metadata).toEqual({
      originalFilename: "Rechnung Juli.png",
      gmailMessageId: "m-1",
    });
  });

  it("setMetadata merges custom keys without clobbering (download-token flow)", async () => {
    const file = bucket().file("files/u1/b.pdf");
    await file.save(Buffer.from("x"), {
      contentType: "application/pdf",
      metadata: { metadata: { originalFilename: "b.pdf" } },
    });

    // gmailSyncQueue: token missing → setMetadata({metadata: {token}})
    await file.setMetadata({ metadata: { firebaseStorageDownloadTokens: "tok-2" } });

    const [meta] = await file.getMetadata();
    expect(meta.contentType).toBe("application/pdf");
    expect(meta.metadata?.originalFilename).toBe("b.pdf");
    expect(meta.metadata?.firebaseStorageDownloadTokens).toBe("tok-2");
  });

  it("throws code 404 on download/delete/getMetadata of a missing object", async () => {
    const file = bucket().file("files/u1/missing.pdf");
    await expect(file.download()).rejects.toMatchObject({ code: 404 });
    await expect(file.delete()).rejects.toMatchObject({ code: 404 });
    await expect(file.getMetadata()).rejects.toMatchObject({ code: 404 });
  });

  it("getFiles({prefix}) lists only the folder; listed handles can delete (processPendingDeletions shape)", async () => {
    await bucket().file("files/u1/one.pdf").save(Buffer.from("1"));
    await bucket().file("files/u1/two.pdf").save(Buffer.from("2"));
    await bucket().file("files/u2/other.pdf").save(Buffer.from("3"));

    const [files] = await bucket().getFiles({ prefix: `files/u1/` });
    expect(files.map((f) => f.name)).toEqual(["files/u1/one.pdf", "files/u1/two.pdf"]);

    for (const f of files) await f.delete();

    const [after] = await bucket().getFiles({ prefix: "files/" });
    expect(after.map((f) => f.name)).toEqual(["files/u2/other.pdf"]);
  });

  it("fails loudly when no backend is configured (boot still fine)", async () => {
    // FIBUKI_S3_ENDPOINT alone also selects the S3 backend, and the compose
    // CI profile exports it suite-wide — clear both, restore after.
    const prev = { store: process.env.FIBUKI_STORAGE, s3: process.env.FIBUKI_S3_ENDPOINT };
    delete process.env.FIBUKI_STORAGE;
    delete process.env.FIBUKI_S3_ENDPOINT;
    _resetStorageForTests();

    try {
      const file = bucket().file("files/u1/x.pdf"); // boot-time surface works
      await expect(file.save(Buffer.from("x"))).rejects.toThrow(/no blob store configured/);
    } finally {
      if (prev.store !== undefined) process.env.FIBUKI_STORAGE = prev.store;
      if (prev.s3 !== undefined) process.env.FIBUKI_S3_ENDPOINT = prev.s3;
      _resetStorageForTests();
    }
  });
});

describe("selfhost: deleteDraftImport callable deletes the CSV blob", () => {
  function call(data: unknown, auth?: { uid: string }) {
    return deleteDraftImportCallable.run({ data, auth } as never);
  }

  beforeEach(async () => {
    await db.collection("imports").doc("imp-1").set({
      userId: USER,
      status: "draft",
      sourceId: "src-1",
      csvStoragePath: `imports/${USER}/imp-1.csv`,
    });
    await bucket().file(`imports/${USER}/imp-1.csv`).save(Buffer.from("a;b;c"), {
      contentType: "text/csv",
    });
  });

  it("deletes blob and import record", async () => {
    const res = await call({ importId: "imp-1" }, { uid: USER });
    expect(res).toEqual({ success: true });

    const [exists] = await bucket().file(`imports/${USER}/imp-1.csv`).exists();
    expect(exists).toBe(false);
    expect((await db.collection("imports").doc("imp-1").get()).exists).toBe(false);
  });

  it("still deletes the record when the blob is already gone (warn, not fail)", async () => {
    await bucket().file(`imports/${USER}/imp-1.csv`).delete();

    const res = await call({ importId: "imp-1" }, { uid: USER });
    expect(res).toEqual({ success: true });
    expect((await db.collection("imports").doc("imp-1").get()).exists).toBe(false);
  });
});

describe("selfhost: testInboundEmail end to end (attachment → storage → files doc)", () => {
  // Tiny valid-enough PDF payload; body (html/text) deliberately absent so
  // the puppeteer HTML→PDF path stays out of scope.
  const PDF_B64 = Buffer.from("%PDF-1.4 fake invoice bytes").toString("base64");

  function mockRes() {
    const res = {
      statusCode: 0,
      body: undefined as unknown,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(payload: unknown) {
        this.body = payload;
        return this;
      },
      send(payload: unknown) {
        this.body = payload;
        return this;
      },
    };
    return res;
  }

  beforeEach(async () => {
    process.env.FUNCTIONS_EMULATOR = "true";
    await db.collection("inboundEmailAddresses").doc("addr-1").set({
      userId: USER,
      email: "invoices-abc123@fibuki.com",
      emailPrefix: "abc123",
      isActive: true,
      dailyLimit: 50,
      todayCount: 0,
    });
  });

  async function post(payload: unknown) {
    const res = mockRes();
    await (testInboundEmail as unknown as (req: unknown, res: unknown) => Promise<void>)(
      { method: "POST", body: payload },
      res,
    );
    return res;
  }

  // Regression guard for a former REAL BUG (fixed 2026-07-19): the log and
  // files-doc writers used to pass `fromName` / `bodyConvertedToFile` /
  // `inboundFromName` through as `undefined` when absent (no display name,
  // no convertible body), and firebase-admin's default undefined rejection
  // 500'd the request AFTER the attachment was stored. The writers now omit
  // absent optional fields, so this deliberately body-less, display-name-less
  // email must complete.
  it("stores the attachment, creates files doc + inbound log, updates stats", async () => {
    const res = await post({
      to: "invoices-abc123@fibuki.com",
      from: "billing@hetzner.com",
      subject: "Invoice R0011223344",
      attachments: [
        { filename: "hetzner.pdf", contentType: "application/pdf", content: PDF_B64 },
      ],
    });

    expect(res.statusCode).toBe(200);
    const body = res.body as { success: boolean; filesCreated: number };
    expect(body.success).toBe(true);

    // files doc
    const filesSnap = await db.collection("files").where("userId", "==", USER).get();
    expect(filesSnap.docs.length).toBe(1);
    const fileDoc = filesSnap.docs[0].data();
    expect(fileDoc.sourceType).toBe("email_inbound");
    expect(fileDoc.fileName).toBe("hetzner.pdf");
    expect(fileDoc.fileType).toBe("application/pdf");
    expect(fileDoc.storagePath).toMatch(new RegExp(`^files/${USER}/\\d+_hetzner\\.pdf$`));
    // absent optional field is OMITTED, not written as undefined/null
    expect("inboundFromName" in fileDoc).toBe(false);

    // the blob actually landed, with the contentType uploadToStorage set
    const file = bucket().file(fileDoc.storagePath as string);
    const [data] = await file.download();
    expect(data.toString()).toContain("%PDF-1.4");
    const [meta] = await file.getMetadata();
    expect(meta.contentType).toBe("application/pdf");
    expect(meta.cacheControl).toBe("public, max-age=31536000");

    // inbound log — no bodyConvertedToFile / fromName keys for this email
    const logSnap = await db
      .collection("inboundEmailLogs")
      .where("inboundAddressId", "==", "addr-1")
      .get();
    expect(logSnap.docs.length).toBe(1);
    const logDoc = logSnap.docs[0].data();
    expect(logDoc.status).toBe("completed");
    expect(logDoc.attachmentsProcessed).toBe(1);
    expect("bodyConvertedToFile" in logDoc).toBe(false);
    expect("fromName" in logDoc).toBe(false);

    // address stats
    const addr = (await db.collection("inboundEmailAddresses").doc("addr-1").get()).data()!;
    expect(addr.emailsReceived).toBe(1);
    expect(addr.filesCreated).toBe(1);
    expect(addr.todayCount).toBe(1);
  });

  it("rejects senders outside allowedDomains without touching storage", async () => {
    await db.collection("inboundEmailAddresses").doc("addr-1").update({
      allowedDomains: ["hetzner.com"],
    });

    const res = await post({
      to: "invoices-abc123@fibuki.com",
      from: "spam@evil.example",
      subject: "totally an invoice",
      attachments: [
        { filename: "x.pdf", contentType: "application/pdf", content: PDF_B64 },
      ],
    });

    expect(res.statusCode).toBe(200);
    expect((res.body as { rejected?: boolean }).rejected).toBe(true);

    const [files] = await bucket().getFiles({ prefix: "files/" });
    expect(files.length).toBe(0);
    const logSnap = await db.collection("inboundEmailLogs").get();
    expect(logSnap.docs[0].data().rejectionReason).toBe("domain_blocked");
  });
});
