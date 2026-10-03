/**
 * Split (#550): one File that holds several separately issued invoices or
 * Receipts becomes one File per invoice or Receipt, through the tool surface
 * a caller uses. Asserts on stored records and replies only.
 */

import { createHash } from "crypto";
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";
import { getStorage, _resetStorageForTests } from "./storage-shim";

// REAL application code, unmodified:
import { handleTool } from "../tools/handlers";
import { buildSplitParts } from "../files/splitFile";
import { restoreFileCallable } from "../files/restoreFile";

const db = getFirestore();
const USER = "stefan-test";
const OTHER = "someone-else";
const BUNDLE_PATH = `users/${USER}/files/amazon-order.pdf`;

/** A PDF of `pages` pages, each printing its own number. */
async function makePdf(pages: number): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 1; i <= pages; i++) {
    pdf.addPage([300, 400]).drawText(`Seller page ${i}`, { x: 40, y: 300, size: 18, font });
  }
  return Buffer.from(await pdf.save());
}

/** The same PDF with an /Encrypt entry in its trailer, which is all a reader checks. */
async function makeEncryptedPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage();
  pdf.addPage();
  pdf.context.trailerInfo.Encrypt = pdf.context.obj({ Filter: "Standard", V: 1, R: 2 });
  return Buffer.from(await pdf.save());
}

async function storeBytes(path: string, bytes: Buffer) {
  await getStorage().bucket().file(path).save(bytes);
}

async function seedBundle(extra: Record<string, unknown> = {}, bytes?: Buffer) {
  await storeBytes(BUNDLE_PATH, bytes ?? (await makePdf(4)));
  await db.collection("files").doc("f-bundle").set({
    userId: USER,
    fileName: "20260310_Tax Invoice_306-2672608-0376346.pdf",
    fileType: "application/pdf",
    storagePath: BUNDLE_PATH,
    contentHash: "hash-of-the-bundle",
    extractionComplete: true,
    transactionIds: ["t-amazon"],
    ...extra,
  });
  await db.collection("transactions").doc("t-amazon").set({
    userId: USER,
    date: Timestamp.fromDate(new Date("2026-03-10T00:00:00Z")),
    amount: -2020,
    name: "AMAZON MARKETPLACE",
    partnerId: "p-amazon",
    partnerMatchedBy: "auto",
    fileIds: ["f-bundle"],
    isComplete: true,
  });
  await db.collection("fileConnections").doc("c-bundle").set({
    userId: USER,
    fileId: "f-bundle",
    transactionId: "t-amazon",
    connectionType: "manual",
  });
}

async function fileDoc(id: string) {
  return (await db.collection("files").doc(id).get()).data()!;
}

async function txDoc(id: string) {
  return (await db.collection("transactions").doc(id).get()).data()!;
}

async function allFileIds(): Promise<string[]> {
  return (await db.collection("files").get()).docs.map((d) => d.id).sort();
}

const RANGES_2_1_1 = [
  { from: 1, to: 2 },
  { from: 3, to: 3 },
  { from: 4, to: 4 },
];

beforeAll(() => {
  process.env.FIBUKI_STORAGE = "memory";
});

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
  _resetStorageForTests();
});

describe("split_file: a four-page bundle split 2+1+1", () => {
  it("makes three Files holding the right pages, each with its own hash", async () => {
    await seedBundle();
    const reply = (await handleTool(USER, "split_file", { fileId: "f-bundle", ranges: RANGES_2_1_1 })) as {
      fileIds: string[];
      transactionIds: string[];
    };

    expect(reply.fileIds).toHaveLength(3);
    expect(reply.transactionIds).toEqual(["t-amazon"]);

    const parts = await Promise.all(reply.fileIds.map(fileDoc));
    const pageCounts = await Promise.all(
      parts.map(async (p) => {
        const [bytes] = await getStorage().bucket().file(p.storagePath).download();
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(p.contentHash);
        return (await PDFDocument.load(bytes)).getPageCount();
      })
    );
    expect(pageCounts).toEqual([2, 1, 1]);
    expect(new Set(parts.map((p) => p.contentHash)).size).toBe(3);
    expect(parts.map((p) => p.fileType)).toEqual(["application/pdf", "application/pdf", "application/pdf"]);
    expect(parts.map((p) => p.splitFrom)).toEqual([
      { fileId: "f-bundle", pages: [1, 2] },
      { fileId: "f-bundle", pages: [3, 3] },
      { fileId: "f-bundle", pages: [4, 4] },
    ]);
    expect(parts.map((p) => p.fileName)).toEqual([
      "20260310_Tax Invoice_306-2672608-0376346 (1-2).pdf",
      "20260310_Tax Invoice_306-2672608-0376346 (3).pdf",
      "20260310_Tax Invoice_306-2672608-0376346 (4).pdf",
    ]);
  });

  it("connects every part to the original's Transaction and deletes the original", async () => {
    await seedBundle();
    const { fileIds } = (await handleTool(USER, "split_file", {
      fileId: "f-bundle",
      ranges: RANGES_2_1_1,
    })) as { fileIds: string[] };

    const tx = await txDoc("t-amazon");
    expect([...tx.fileIds].sort()).toEqual([...fileIds].sort());
    expect(tx.isComplete).toBe(true);
    for (const id of fileIds) {
      expect((await fileDoc(id)).transactionIds).toEqual(["t-amazon"]);
    }
    const connections = (await db.collection("fileConnections").where("transactionId", "==", "t-amazon").get()).docs;
    expect(connections.map((c) => c.data().fileId).sort()).toEqual([...fileIds].sort());

    const original = await fileDoc("f-bundle");
    expect(original.deletedAt).toBeTruthy();
    expect(original.purgedAt ?? null).toBeNull();
    expect(original.splitInto).toEqual(fileIds);
    expect(original.transactionIds).toEqual([]);
    // The bundle's bytes stay on record (BAO § 132): Split deletes, never Purges.
    const [kept] = await getStorage().bucket().file(BUNDLE_PATH).exists();
    expect(kept).toBe(true);
    // The Transaction keeps its payee.
    expect(tx.partnerId).toBe("p-amazon");
  });

  it("copies no hand correction and no source identifier onto the parts", async () => {
    await seedBundle({
      partnerId: "p-seller-pl",
      partnerMatchedBy: "manual",
      extractedAmount: 2020,
      extractedInvoiceNumber: "PL600029H28QLI",
      extractedLineItems: [{ description: "Bundle", amount: 2020, vatAmount: 0, vatPercent: 0 }],
      sourceType: "gmail",
      mailMessageId: "msg-1",
      mailAttachmentId: "att-1",
      gmailIntegrationId: "int-1",
      sourceIntegrationId: "folder-1",
      sourceExternalId: "dropbox-file-1",
      splitSuggestion: { pageCount: 4, segments: [] },
    });
    const { fileIds } = (await handleTool(USER, "split_file", {
      fileId: "f-bundle",
      ranges: RANGES_2_1_1,
    })) as { fileIds: string[] };

    for (const id of fileIds) {
      const part = await fileDoc(id);
      expect(part.sourceType).toBe("gmail");
      for (const key of [
        "partnerId",
        "extractedAmount",
        "extractedInvoiceNumber",
        "extractedLineItems",
        "mailMessageId",
        "mailAttachmentId",
        "gmailIntegrationId",
        "sourceIntegrationId",
        "sourceExternalId",
        "splitSuggestion",
      ]) {
        expect(part[key], key).toBeUndefined();
      }
      expect(part.extractionComplete).toBe(false);
    }
    expect((await fileDoc("f-bundle")).splitSuggestion).toBeNull();
  });
});

describe("split_file: refusals write nothing", () => {
  async function expectRefused(args: Record<string, unknown>, message: RegExp, userId = USER) {
    const before = await allFileIds();
    await expect(handleTool(userId, "split_file", args)).rejects.toThrow(message);
    expect(await allFileIds()).toEqual(before);
    const original = (await db.collection("files").doc(String(args.fileId)).get()).data();
    if (original?.userId === USER) {
      expect(original.splitInto ?? null).toBeNull();
    }
  }

  it("refuses a single-page PDF", async () => {
    await seedBundle({}, await makePdf(1));
    await expectRefused({ fileId: "f-bundle", ranges: [{ from: 1, to: 1 }, { from: 1, to: 1 }] }, /single page/);
  });

  it("refuses an image, whatever its stored type says", async () => {
    const png = Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG\r\n\x1a\n"), Buffer.alloc(32)]);
    await seedBundle({ fileType: "application/pdf" }, png);
    await expectRefused({ fileId: "f-bundle", ranges: RANGES_2_1_1 }, /Only a PDF/);
  });

  it("refuses a deleted File", async () => {
    await seedBundle({ deletedAt: Timestamp.now() });
    await expectRefused({ fileId: "f-bundle", ranges: RANGES_2_1_1 }, /deleted File/);
  });

  it("refuses an encrypted PDF", async () => {
    await seedBundle({}, await makeEncryptedPdf());
    await expectRefused({ fileId: "f-bundle", ranges: [{ from: 1, to: 1 }, { from: 2, to: 2 }] }, /encrypted/);
  });

  it("refuses a FiBuKI-generated invoice document", async () => {
    await seedBundle({ invoiceId: "inv-1", isFibukiGenerated: true });
    await expectRefused({ fileId: "f-bundle", ranges: RANGES_2_1_1 }, /GENERATED_INVOICE/);
  });

  it("refuses a gap", async () => {
    await seedBundle();
    await expectRefused({ fileId: "f-bundle", ranges: [{ from: 1, to: 2 }, { from: 4, to: 4 }] }, /Page 3 is in no range/);
  });

  it("refuses a trailing gap", async () => {
    await seedBundle();
    await expectRefused({ fileId: "f-bundle", ranges: [{ from: 1, to: 1 }, { from: 2, to: 2 }] }, /Pages 3-4 are in no range/);
  });

  it("refuses an overlap", async () => {
    await seedBundle();
    await expectRefused({ fileId: "f-bundle", ranges: [{ from: 1, to: 2 }, { from: 2, to: 4 }] }, /overlaps/);
  });

  it("refuses a single range", async () => {
    await seedBundle();
    await expectRefused({ fileId: "f-bundle", ranges: [{ from: 1, to: 4 }] }, /at least two/);
  });

  it("refuses a range outside the document", async () => {
    await seedBundle();
    await expectRefused({ fileId: "f-bundle", ranges: [{ from: 1, to: 2 }, { from: 3, to: 5 }] }, /has 4 pages/);
  });

  it("refuses another user's File as not found", async () => {
    await seedBundle({ userId: OTHER });
    await expectRefused({ fileId: "f-bundle", ranges: RANGES_2_1_1 }, /File not found/);
  });

  it("refuses the whole Split when one part's pages are already on file", async () => {
    const bytes = await makePdf(4);
    await seedBundle({}, bytes);
    const parts = await buildSplitParts(await PDFDocument.load(bytes), RANGES_2_1_1);
    await db.collection("files").doc("f-seller-hk").set({
      userId: USER,
      fileName: "Quittung HK.pdf",
      contentHash: createHash("sha256").update(parts[1]).digest("hex"),
    });
    await expectRefused({ fileId: "f-bundle", ranges: RANGES_2_1_1 }, /Page 3 is already on file as "Quittung HK.pdf"/);
    expect((await txDoc("t-amazon")).fileIds).toEqual(["f-bundle"]);
    expect((await fileDoc("f-bundle")).deletedAt ?? null).toBeNull();
  });
});

describe("restoring a split original", () => {
  it("is refused while a part exists, naming it, and allowed once every part is deleted", async () => {
    await seedBundle();
    const { fileIds } = (await handleTool(USER, "split_file", {
      fileId: "f-bundle",
      ranges: [{ from: 1, to: 2 }, { from: 3, to: 4 }],
    })) as { fileIds: string[] };

    await handleTool(USER, "delete_file", { fileId: fileIds[0], confirm: true });
    await expect(handleTool(USER, "restore_file", { fileId: "f-bundle" })).rejects.toThrow(
      /20260310_Tax Invoice_306-2672608-0376346 \(3-4\)\.pdf/
    );
    await expect(
      restoreFileCallable.run({ data: { fileId: "f-bundle" }, auth: { uid: USER, token: {} } } as never)
    ).rejects.toThrow(/its parts still exist/);
    expect((await fileDoc("f-bundle")).deletedAt).toBeTruthy();

    await handleTool(USER, "delete_file", { fileId: fileIds[1], confirm: true });
    expect(await handleTool(USER, "restore_file", { fileId: "f-bundle" })).toMatchObject({ restored: true });
    expect((await fileDoc("f-bundle")).deletedAt).toBeNull();
  });
});
