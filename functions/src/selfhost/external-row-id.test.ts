/**
 * External Row Id (#796, spec #800): an importer's own id for one bank line,
 * unique per Bank Account. A row whose id the Bank Account already stores is
 * skipped whatever the import job, so a retried or resumed Import never
 * writes a bank line twice. Rows without one keep today's duplicate check.
 *
 * Driven through import_transactions against the self-host in-memory
 * database; asserted on the stored rows and the Import result.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";

// REAL application code, unmodified:
import { handleTool } from "../tools/handlers";

const db = getFirestore();
const USER = "eri-user";

type ImportResult = { count: number; duplicateCount: number; transactionIds: string[] };

const line = (externalRowId: string | undefined, extra: Record<string, unknown> = {}) => ({
  date: "2026-07-06",
  amount: -450,
  currency: "EUR",
  name: "Cafe Central",
  ...(externalRowId === undefined ? {} : { externalRowId }),
  ...extra,
});

function importRows(rows: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}, sourceId = "src-1") {
  return handleTool(USER, "import_transactions", { sourceId, transactions: rows, ...extra }) as Promise<ImportResult>;
}

async function storedIds(sourceId = "src-1") {
  const snap = await db.collection("transactions").where("sourceId", "==", sourceId).get();
  return snap.docs.map((d) => d.data().externalRowId ?? null).sort();
}

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
  for (const id of ["src-1", "src-2"]) {
    await db.collection("sources").doc(id).set({ userId: USER, name: id, type: "manual", isActive: true });
  }
});

describe("import_transactions stores an External Row Id per row", () => {
  it("stores it on the Transaction", async () => {
    const res = await importRows([line("bank-1")]);

    expect(res.count).toBe(1);
    expect((await db.collection("transactions").doc(res.transactionIds[0]).get()).data()!.externalRowId).toBe("bank-1");
  });

  it("refuses one that is not a non-empty string", async () => {
    await expect(importRows([line("")])).rejects.toThrow(/externalRowId/);
    await expect(importRows([{ ...line(undefined), externalRowId: 42 }])).rejects.toThrow(/externalRowId/);
    expect(await storedIds()).toEqual([]);
  });
});

describe("a stored External Row Id is skipped whatever the import job", () => {
  it("from a different import job", async () => {
    await importRows([line("bank-1")]);

    const res = await importRows([line("bank-1"), line("bank-2")]);

    expect(res).toMatchObject({ count: 1, duplicateCount: 1 });
    expect(await storedIds()).toEqual(["bank-1", "bank-2"]);
  });

  it("within the same import job: a resume", async () => {
    await importRows([line("bank-1")], { importJobId: "job-a" });

    const res = await importRows([line("bank-1"), line("bank-2")], { importJobId: "job-a" });

    expect(res).toMatchObject({ count: 1, duplicateCount: 1 });
    expect(await storedIds()).toEqual(["bank-1", "bank-2"]);
  });

  it("twice in one call: the second is skipped", async () => {
    const res = await importRows([line("bank-1"), line("bank-1")]);

    expect(res).toMatchObject({ count: 1, duplicateCount: 1 });
  });

  it("keeps two lines of the same day and amount with different ids, across jobs too", async () => {
    await importRows([line("bank-1")]);

    const res = await importRows([line("bank-2"), line("bank-3")]);

    expect(res).toMatchObject({ count: 2, duplicateCount: 0 });
    expect(await storedIds()).toEqual(["bank-1", "bank-2", "bank-3"]);
  });

  it("the same id on another Bank Account is not a duplicate", async () => {
    await importRows([line("bank-1")]);

    const res = await importRows([line("bank-1")], {}, "src-2");

    expect(res).toMatchObject({ count: 1, duplicateCount: 0 });
    expect(await storedIds("src-2")).toEqual(["bank-1"]);
  });

  it("another User's id on the same-named row is not a duplicate", async () => {
    await db.collection("transactions").doc("foreign").set({ userId: "someone-else", sourceId: "src-1", externalRowId: "bank-1" });

    const res = await importRows([line("bank-1")]);

    expect(res).toMatchObject({ count: 1, duplicateCount: 0 });
  });
});

describe("rows without an External Row Id keep today's duplicate check", () => {
  it("skips a line an earlier import stored, and keeps identical lines of one job", async () => {
    await importRows([line(undefined)]);

    const again = await importRows([line(undefined)]);
    expect(again).toMatchObject({ count: 0, duplicateCount: 1 });

    const twins = await importRows([line(undefined, { date: "2026-07-07" }), line(undefined, { date: "2026-07-07" })], {
      importJobId: "job-b",
    });
    expect(twins).toMatchObject({ count: 2, duplicateCount: 0 });
    expect(await storedIds()).toEqual([null, null, null]);
  });

  it("stored rows without an id are not backfilled", async () => {
    await importRows([line(undefined)]);
    await importRows([line("bank-1", { date: "2026-07-08" })]);

    expect(await storedIds()).toEqual(["bank-1", null].sort());
  });

  it("stays the backstop for a row with an id against a stored row without one", async () => {
    await importRows([line(undefined)]);

    const same = await importRows([line("bank-1")]);
    expect(same).toMatchObject({ count: 0, duplicateCount: 1 });

    const other = await importRows([line("bank-2", { amount: -460 })]);
    expect(other).toMatchObject({ count: 1, duplicateCount: 0 });
  });
});
