/**
 * The other writers of a File's extracted facts through the File facts module,
 * on the self-host shim (#640): marking a File Not Invoice (callable and MCP
 * tool), the entity-name backfill, and the dry-run report of Files whose
 * hand-corrected direction an earlier identity sweep may have changed. The
 * sweep itself keeping a hand-corrected direction is in
 * `user-data-direction-sweep-report.test.ts`.
 *
 *   npx vitest run --config vitest.selfhost.config.ts src/selfhost/other-fact-writers.test.ts --pool=forks --maxWorkers=1
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { getFirestore, Timestamp, __rawSqlForTest, __resetFirestoreShim } from "./firestore-shim";
import { drainTriggers } from "./trigger-shim";

const fake = vi.hoisted(() => ({ started: [] as string[] }));

// The Extraction a re-opened File gets: what matters here is whether it runs.
vi.mock("../extraction/extractionCore", async () => {
  const { getFirestore: db } = await import("./firestore-shim");
  return {
    runExtraction: async (fileId: string) => {
      fake.started.push(fileId);
      await db().collection("files").doc(fileId).update({
        classificationComplete: true,
        extractionComplete: true,
        extractedAmount: 4200,
      });
      return { success: true, duration: 1 };
    },
  };
});

// REAL application code, unmodified:
import { drainExtractionQueue } from "./extraction-worker";
import { markFileAsNotInvoiceCallable } from "../files/markFileAsNotInvoice";
import { unmarkFileAsNotInvoiceCallable } from "../files/unmarkFileAsNotInvoice";
import { markFileAsNotInvoice, unmarkFileAsNotInvoice } from "../tools/handlers";
import { backfillFileEntityNamesCallable } from "../files/backfillFileEntityNames";
import { reportSweptHandCorrectedDirections } from "./report-swept-hand-corrected-directions";

const db = getFirestore();
const ME = "writers-me";
const OTHER = "writers-other";

const at = (iso: string) => Timestamp.fromDate(new Date(iso));
const day = (iso: string) => at(`${iso}T00:00:00Z`);

type Callable = { run: (req: unknown) => Promise<unknown> };
const asUser = (callable: unknown, data: unknown, uid = ME) =>
  (callable as Callable).run({ data, auth: { uid, token: {} } });

const fileData = async (id: string) => (await db.collection("files").doc(id).get()).data()!;

async function jobs(): Promise<Record<string, unknown>[]> {
  return (await __rawSqlForTest(`SELECT file_id, skip_classification FROM extraction_jobs ORDER BY file_id`)).rows;
}

/** An extracted invoice the User corrected by hand: the amount, the direction and the Due Date row. */
async function seedCorrected(id: string, extra: Record<string, unknown> = {}) {
  await db.collection("files").doc(id).set({
    userId: ME,
    fileName: `${id}.pdf`,
    storagePath: `uploads/${id}.pdf`,
    extractionComplete: true,
    classificationComplete: true,
    isNotInvoice: false,
    extractedAmount: 9999,
    extractedDate: day("2026-03-01"),
    extractedTipAmount: 200,
    extractedDueDate: day("2026-03-20"),
    extractedAdditionalFields: [{ key: "dueDate", label: "Fällig", value: "2026-03-20" }],
    extractedInstalments: [
      { amount: 5000, dueDate: day("2026-03-20") },
      { amount: 4999, dueDate: day("2026-04-20") },
    ],
    extractedPartner: "Lieferant GmbH",
    invoiceDirection: "outgoing",
    extractionCorrectedFields: {
      amount: at("2026-09-01T10:00:00Z"),
      invoiceDirection: at("2026-09-01T10:00:00Z"),
      tipAmount: at("2026-09-02T10:00:00Z"),
      dueDate: at("2026-09-03T10:00:00Z"),
    },
    extractionCorrectedAt: at("2026-09-03T10:00:00Z"),
    transactionIds: [],
    ...extra,
  });
  await drainTriggers();
}

beforeAll(async () => {
  // The upload and undelete triggers, as the barrel registers them.
  await import("../extraction/extractFileData");
});

beforeEach(async () => {
  await __resetFirestoreShim();
  fake.started.length = 0;
});

describe("marking a File Not Invoice clears its Hand Correction record (#640)", () => {
  it("through the callable: the record goes with the figures, and un-marking re-extracts without a refusal", async () => {
    await seedCorrected("f1");

    await asUser(markFileAsNotInvoiceCallable, { fileId: "f1", reason: "a delivery note" });

    const marked = await fileData("f1");
    expect(marked).toMatchObject({
      isNotInvoice: true,
      notInvoiceReason: "a delivery note",
      extractedAmount: null,
      extractedTipAmount: null,
      extractedDueDate: null,
      extractedInstalments: null,
      invoiceDirection: null,
      extractionCorrectedFields: null,
      extractionCorrectedAt: null,
    });
    expect((marked.lastFactChange as { origin: string }).origin).toBe("not-invoice");

    await asUser(unmarkFileAsNotInvoiceCallable, { fileId: "f1" });
    await drainTriggers();
    expect(await jobs()).toMatchObject([{ file_id: "f1", skip_classification: true }]);

    expect(await drainExtractionQueue()).toBe(1);
    expect(fake.started).toEqual(["f1"]);
    expect(await fileData("f1")).toMatchObject({ isNotInvoice: false, extractionComplete: true, extractedAmount: 4200 });
  });

  it("through the MCP tool, the same", async () => {
    await seedCorrected("f2");

    await markFileAsNotInvoice(ME, { fileId: "f2" });
    expect(await fileData("f2")).toMatchObject({ extractionCorrectedFields: null, extractionCorrectedAt: null });

    await unmarkFileAsNotInvoice(ME, { fileId: "f2" });
    await drainTriggers();
    expect(await drainExtractionQueue()).toBe(1);
    expect(fake.started).toEqual(["f2"]);
  });

  it("a File marked before #640 still carries its record, and un-marking it is still refused", async () => {
    // As the old builder left it: figures cleared, the record kept.
    await seedCorrected("old", {
      isNotInvoice: true,
      notInvoiceReason: "Marked by user",
      extractedAmount: null,
      invoiceDirection: null,
    });

    await expect(unmarkFileAsNotInvoice(ME, { fileId: "old" })).rejects.toThrow(
      "hand corrections a re-extraction would discard"
    );
    // The structured refusal the "corrections will be lost" dialog opens on (#699).
    await expect(asUser(unmarkFileAsNotInvoiceCallable, { fileId: "old" })).rejects.toMatchObject({
      code: "failed-precondition",
      details: { code: "HAND_CORRECTED", fields: ["amount", "invoiceDirection", "tipAmount", "dueDate"] },
    });
    await drainTriggers();
    expect(await jobs()).toHaveLength(0);
    expect(await fileData("old")).toMatchObject({ isNotInvoice: true });
  });

  it("another User's File is not marked", async () => {
    await seedCorrected("theirs", { userId: OTHER });

    await expect(asUser(markFileAsNotInvoiceCallable, { fileId: "theirs" })).rejects.toBeDefined();
    await expect(markFileAsNotInvoice(ME, { fileId: "theirs" })).rejects.toThrow("File not found");

    expect(await fileData("theirs")).toMatchObject({ isNotInvoice: false, extractedAmount: 9999 });
  });
});

describe("the entity-name backfill writes through the module (#299, #640)", () => {
  it("decodes the stored names and stamps the write; a clean File is skipped", async () => {
    await db.collection("files").doc("enc").set({
      userId: ME,
      extractedIssuer: { name: "AL&amp;FA Taxi KG", vatId: "ATU1" },
      extractedPartner: "AL&amp;FA Taxi KG",
    });
    await db.collection("files").doc("clean").set({ userId: ME, extractedPartner: "AT&T" });
    await db.collection("files").doc("theirs").set({ userId: OTHER, extractedPartner: "A&amp;B" });

    const result = await asUser(backfillFileEntityNamesCallable, {});

    expect(result).toEqual({ success: true, updated: 1, skipped: 1 });
    const enc = await fileData("enc");
    expect(enc.extractedIssuer).toEqual({ name: "AL&FA Taxi KG", vatId: "ATU1" });
    expect(enc.extractedPartner).toBe("AL&FA Taxi KG");
    expect((enc.lastFactChange as { origin: string }).origin).toBe("entity-name-backfill");
    expect((await fileData("theirs")).extractedPartner).toBe("A&amp;B");
  });
});

describe("the dry-run report of hand-corrected directions an earlier sweep may have changed (#640)", () => {
  async function sweepRun(
    userId: string,
    runId: string,
    startedAt: string,
    extra: Record<string, unknown> = {}
  ) {
    const finishedAt = new Date(new Date(startedAt).getTime() + 60_000).toISOString();
    await db.collection(`users/${userId}/directionSweeps`).doc(runId).set({
      runId,
      userId,
      startedAt,
      finishedAt,
      candidates: 10,
      outcomes: { written: 3, "already-correct": 7 },
      complete: true,
      ...extra,
    });
  }

  async function corrected(id: string, userId: string, stamps: Record<string, string>, extra: Record<string, unknown> = {}) {
    const fields = Object.fromEntries(Object.entries(stamps).map(([field, iso]) => [field, at(iso)]));
    const newest = Object.values(stamps).sort().at(-1)!;
    await db.collection("files").doc(id).set({
      userId,
      fileName: `${id}.pdf`,
      invoiceDirection: "incoming",
      extractionCorrectedFields: fields,
      extractionCorrectedAt: at(newest),
      updatedAt: at("2026-01-01T00:00:00Z"),
      ...extra,
    });
  }

  beforeEach(async () => {
    // Before #640: runs that wrote Files and kept no hand-corrected direction.
    await sweepRun(ME, "run-may", "2026-05-10T08:00:00.000Z");
    await sweepRun(ME, "run-aug", "2026-08-10T08:00:00.000Z");
    // Since #640: it kept every hand-corrected direction, so it flipped none.
    await sweepRun(ME, "run-oct", "2026-10-06T08:00:00.000Z", {
      keepsHandCorrectedDirections: true,
      directionsKept: 1,
    });
    // A run that wrote nothing could flip nothing.
    await sweepRun(ME, "run-idle", "2026-09-20T08:00:00.000Z", { outcomes: { "already-correct": 10 } });
    // Another User's run says nothing about my Files, only about theirs.
    await sweepRun(OTHER, "run-other", "2026-09-25T08:00:00.000Z");

    await corrected("set-in-april", ME, { invoiceDirection: "2026-04-01T09:00:00Z" });
    await corrected("set-in-july", ME, { invoiceDirection: "2026-07-01T09:00:00Z", amount: "2026-07-02T09:00:00Z" });
    await corrected("set-in-september", ME, { invoiceDirection: "2026-09-01T09:00:00Z" });
    await corrected("amount-only", ME, { amount: "2026-04-01T09:00:00Z" });
    await corrected("not-invoice", ME, { invoiceDirection: "2026-04-01T09:00:00Z" }, { isNotInvoice: true });
    await corrected("other-users", OTHER, { invoiceDirection: "2026-09-01T09:00:00Z" });
    await db.collection("files").doc("never-corrected").set({ userId: ME, invoiceDirection: "incoming" });
  });

  it("lists the Files a later run that kept no hand-corrected direction could have flipped", async () => {
    const report = await reportSweptHandCorrectedDirections({ log: () => {} });

    expect(report.candidates.map((c) => [c.fileId, c.runs.map((r) => r.runId)])).toEqual([
      ["set-in-april", ["run-may", "run-aug"]],
      ["set-in-july", ["run-aug"]],
      // Their own run, not mine, could have flipped theirs.
      ["other-users", ["run-other"]],
    ]);
    expect(report.candidates[0]).toMatchObject({
      userId: ME,
      fileName: "set-in-april.pdf",
      direction: "incoming",
      directionCorrectedAt: "2026-04-01T09:00:00.000Z",
      deleted: false,
    });
    expect(report.runsRead).toBe(5);
    expect(report.runsThatCouldFlip).toBe(3);
    expect(report.earliestRunAt).toBe("2026-05-10T08:00:00.000Z");
    // Every File whose record names the direction, the Not Invoice one included.
    expect(report.handCorrectedDirections).toBe(5);
  });

  it("narrows to one User", async () => {
    const report = await reportSweptHandCorrectedDirections({ userId: ME, log: () => {} });

    expect(report.candidates.map((c) => c.fileId)).toEqual(["set-in-april", "set-in-july"]);
    expect(report.runsRead).toBe(4);
  });

  it("writes nothing", async () => {
    const before = await fileData("set-in-april");

    await reportSweptHandCorrectedDirections({ log: () => {} });

    expect(await fileData("set-in-april")).toEqual(before);
  });
});
