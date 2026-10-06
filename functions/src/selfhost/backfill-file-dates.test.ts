/**
 * #641: the one-time backfill that stores every File's Due Date and Debit
 * Date as the File facts module derives them. Seeded Files on the shim, the
 * real module and applier; the dry run and the applied run report the same
 * figures, and the applied run is idempotent.
 *
 *   npx vitest run --config vitest.selfhost.config.ts src/selfhost/backfill-file-dates.test.ts --pool=forks --maxWorkers=1
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";
import { backfillFileDates, type FileDatesBackfillOptions } from "./backfill-file-dates";

const db = getFirestore();
const silent = () => {};
const ME = "dates-me";
const OTHER = "dates-other";
const AT = Timestamp.fromDate(new Date("2026-10-06T10:00:00Z"));
const EARLIER = Timestamp.fromDate(new Date("2026-09-01T10:00:00Z"));
const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));
const isoOf = (value: unknown) => (value as Timestamp | null | undefined)?.toDate().toISOString().slice(0, 10) ?? null;

const ISSUE = "2026-03-02";
const due = (value: string) => ({ key: "dueDate", label: "Fällig am", value });
const debit = (value: string) => ({ key: "debitDate", label: "Einzug am", value });

async function seed(id: string, extra: Record<string, unknown> = {}) {
  await db.collection("files").doc(id).set({
    userId: ME,
    fileName: `${id}.pdf`,
    extractionComplete: true,
    extractedDate: day(ISSUE),
    updatedAt: EARLIER,
    ...extra,
  });
}

const file = async (id: string) => (await db.collection("files").doc(id).get()).data()!;

async function allFiles() {
  const snap = await db.collection("files").get();
  return Object.fromEntries(snap.docs.map((d) => [d.id, d.data()]));
}

function run(opts: FileDatesBackfillOptions = {}) {
  return backfillFileDates({ log: silent, at: AT, ...opts });
}

/** One File of each kind the report counts. */
async function seedCorpus() {
  // Stores no date field; the scorer read both off the rows on the fly.
  await seed("f-legacy", { extractedAdditionalFields: [due("2026-03-16"), debit("2026-03-20")] });
  // Stores an inverted Due Date (before the issue day, #135).
  await seed("f-inverted", {
    extractedAdditionalFields: [due("2026-02-16")],
    extractedDueDate: day("2026-02-16"),
    extractedDebitDate: null,
  });
  // Stores no field; its row is inverted. The scorer read it until #641; no write is needed.
  await seed("f-legacy-inverted", { extractedAdditionalFields: [due("2026-02-20")] });
  // Stores a Due Date its rows no longer state.
  await seed("f-changed", {
    extractedAdditionalFields: [due("2026-03-16")],
    extractedDueDate: day("2026-03-10"),
    extractedDebitDate: null,
  });
  // Stores a Debit Date, and has no rows left.
  await seed("f-lost", { extractedAdditionalFields: null, extractedDueDate: null, extractedDebitDate: day("2026-03-20") });
  // Already right.
  await seed("f-same", {
    extractedAdditionalFields: [due("2026-03-16")],
    extractedDueDate: day("2026-03-16"),
    extractedDebitDate: null,
  });
  // The User set the Due Date by hand: left alone, even though it is inverted.
  await seed("f-hand", {
    extractedAdditionalFields: [due("2026-02-16")],
    extractedDueDate: day("2026-02-16"),
    extractionCorrectedFields: { dueDate: EARLIER },
    extractionCorrectedAt: EARLIER,
  });
  // In its Extraction pipeline.
  await seed("f-pipeline", { extractionComplete: false, extractedAdditionalFields: [due("2026-03-16")] });
  // Another user's File.
  await seed("f-other", { userId: OTHER, extractedAdditionalFields: [due("2026-03-16")] });
}

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
});

describe("backfillFileDates: the dry run", () => {
  it("reports what it would change, and writes nothing", async () => {
    await seedCorpus();
    const before = await allFiles();

    const report = await run();

    expect(await allFiles()).toEqual(before);
    expect(report).toMatchObject({
      scope: { kind: "allUsers" },
      applied: false,
      filesScanned: 9,
      filesChanged: 5,
      dueDate: { gained: 2, changed: 1, lost: 1 },
      debitDate: { gained: 1, changed: 0, lost: 1 },
      inversionsFixed: { dueDate: 2, debitDate: 0 },
      scoredOnTheFly: 3,
      skippedHandCorrected: [{ fileId: "f-hand", userId: ME, fields: ["dueDate"] }],
      skippedInPipeline: ["f-pipeline"],
      refused: [],
      failed: [],
    });
    expect(report.changes.map((c) => c.fileId).sort()).toEqual(
      ["f-changed", "f-inverted", "f-legacy", "f-lost", "f-other"]
    );
    expect(report.changes.find((c) => c.fileId === "f-changed")).toEqual({
      fileId: "f-changed",
      userId: ME,
      fileName: "f-changed.pdf",
      dueDate: { from: "2026-03-10", to: "2026-03-16" },
    });
  });

  it("reads every page", async () => {
    await seedCorpus();
    const paged = await run({ pageSize: 2 });
    const whole = await run();
    expect(paged).toEqual(whole);
  });

  it("covers one user's Files only when given one", async () => {
    await seedCorpus();
    const report = await run({ userId: ME });
    expect(report.scope).toEqual({ kind: "user", userId: ME });
    expect(report.filesScanned).toBe(8);
    expect(report.changes.map((c) => c.userId)).not.toContain(OTHER);
  });
});

describe("backfillFileDates: the applied run", () => {
  it("needs a scope", async () => {
    await expect(run({ apply: true })).rejects.toThrow(/needs a scope/);
    await expect(run({ userId: ME, allUsers: true })).rejects.toThrow(/exclude each other/);
  });

  it("reports the dry run's figures, writes them through the module, and skips the hand-corrected File", async () => {
    await seedCorpus();
    const dry = await run();
    const handBefore = await file("f-hand");
    const pipelineBefore = await file("f-pipeline");

    const applied = await run({ apply: true, allUsers: true });

    expect({ ...applied, applied: false }).toEqual(dry);
    expect(applied.applied).toBe(true);

    const legacy = await file("f-legacy");
    expect(isoOf(legacy.extractedDueDate)).toBe("2026-03-16");
    expect(isoOf(legacy.extractedDebitDate)).toBe("2026-03-20");
    expect(legacy.lastFactChange).toEqual({ origin: "date-backfill", at: AT });
    expect((await file("f-inverted")).extractedDueDate).toBeNull();
    expect(isoOf((await file("f-changed")).extractedDueDate)).toBe("2026-03-16");
    expect((await file("f-lost")).extractedDebitDate).toBeNull();
    expect(isoOf((await file("f-other")).extractedDueDate)).toBe("2026-03-16");

    // Untouched: the hand-corrected File, the one in its pipeline, the one already right,
    // and the inverted legacy record, which stores no date to fix.
    expect(await file("f-hand")).toEqual(handBefore);
    expect(await file("f-pipeline")).toEqual(pipelineBefore);
    expect((await file("f-same")).updatedAt).toEqual(EARLIER);
    expect(await file("f-legacy-inverted")).not.toHaveProperty("extractedDueDate");
  });

  it("is idempotent: a second run writes nothing", async () => {
    await seedCorpus();
    await run({ apply: true, allUsers: true });
    const after = await allFiles();

    const again = await run({ apply: true, allUsers: true });

    expect(await allFiles()).toEqual(after);
    expect(again).toMatchObject({ filesChanged: 0, dueDate: { gained: 0, changed: 0, lost: 0 } });
    expect(again.skippedHandCorrected.map((s) => s.fileId)).toEqual(["f-hand"]);
  });

  it("writes one user's Files only when given one", async () => {
    await seedCorpus();
    await run({ apply: true, userId: ME });
    expect(await file("f-other")).not.toHaveProperty("extractedDueDate");
    expect(isoOf((await file("f-legacy")).extractedDueDate)).toBe("2026-03-16");
  });

  it("hands the planned changes over before the first write", async () => {
    await seedCorpus();
    let planned: Awaited<ReturnType<typeof run>> | null = null;
    let legacyAtPlan: unknown = "unread";
    const report = await run({
      apply: true,
      allUsers: true,
      beforeWrite: async (p) => {
        planned = p;
        legacyAtPlan = (await file("f-legacy")).extractedDueDate;
      },
    });
    expect(legacyAtPlan).toBeUndefined();
    expect(planned!.changes).toEqual(report.changes);
    expect(planned!.applied).toBe(true);
  });

  it("skips a File the User corrects by hand between the plan and the write", async () => {
    await seedCorpus();
    const report = await run({
      apply: true,
      allUsers: true,
      beforeWrite: async () => {
        await db.collection("files").doc("f-inverted").update({
          extractionCorrectedFields: { dueDate: AT },
          extractionCorrectedAt: AT,
        });
      },
    });
    expect(isoOf((await file("f-inverted")).extractedDueDate)).toBe("2026-02-16");
    expect(report.skippedHandCorrected.map((s) => s.fileId).sort()).toEqual(["f-hand", "f-inverted"]);
    expect(report.filesChanged).toBe(4);
    // Only the inverted legacy record is still counted as fixed.
    expect(report.inversionsFixed.dueDate).toBe(1);
  });

  it("re-scores the suggestions of a File whose date moved, connecting nothing", async () => {
    await seed("f-scored", {
      extractedAdditionalFields: [due("2026-03-16")],
      extractedAmount: 4990,
      extractedCurrency: "EUR",
      transactionMatchComplete: true,
      transactionIds: [],
      transactionSuggestions: [{ transactionId: "t-gone", confidence: 55, matchSources: [] }],
    });
    await run({ apply: true, userId: ME });
    const after = await file("f-scored");
    expect(after.transactionSuggestions).toEqual([]);
    expect(after.transactionIds).toEqual([]);
    expect(after.transactionMatchComplete).toBe(true);
  });
});
