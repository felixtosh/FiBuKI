/**
 * #160: the UVA on the tool surface, read-only, from the same run the reports
 * page reads.
 *
 * The reports page gets its figures from `calculateUva` (via
 * /api/reports/calculate). `get_uva_report` must return the same Kennzahlen
 * for the same period, so both are driven from one seeded corpus here and
 * compared. A tool that computed its own numbers would let an agent confirm a
 * figure the human never sees.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";

// REAL application code, unmodified:
import { calculateUvaCallable } from "../reports/calculateUvaCallable";
import { handleTool } from "../tools/handlers";
import { TOOL_DEFINITIONS } from "../tools/definitions";

const db = getFirestore();
const USER = "uva-tool-user";
const Q1 = { year: 2026, period: 1, type: "quarterly" as const };

const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00.000Z`));

function reportsPage(period: unknown) {
  return calculateUvaCallable.run({
    data: { period },
    auth: { uid: USER },
  } as never);
}

async function seedTransaction(
  id: string,
  date: string,
  amount: number,
  fileIds: string[] = [],
  extra: Record<string, unknown> = {}
) {
  await db.collection("transactions").doc(id).set({
    userId: USER,
    sourceId: "src-1",
    date: day(date),
    amount,
    currency: "EUR",
    partner: id,
    fileIds,
    isComplete: fileIds.length > 0,
    ...extra,
  });
}

async function seedCorpus() {
  // Domestic expense, 20% off a printed rate-group block.
  await db.collection("files").doc("f-domestic").set({
    userId: USER,
    extractedAmount: 12000,
    extractedRateGroups: [{ rate: 20, net: 10000, vat: 2000, gross: 12000 }],
  });
  await seedTransaction("t-domestic", "2026-02-01", -12000, ["f-domestic"]);
  // Income at 10%, off a document.
  await db.collection("files").doc("f-income").set({
    userId: USER,
    extractedAmount: 11000,
    extractedRateGroups: [{ rate: 10, net: 10000, vat: 1000, gross: 11000 }],
  });
  await seedTransaction("t-income", "2026-03-05", 11000, ["f-income"]);
  // Manual override lane, no document.
  await seedTransaction("t-typed", "2026-03-20", -6000, [], { vatRate: 20 });
  // Expense with nothing behind it: lands on the worklist.
  await seedTransaction("t-open", "2026-01-15", -4800);
  // Outside the quarter: must not move Q1.
  await seedTransaction("t-april", "2026-04-02", -12000, ["f-domestic"]);
}

beforeEach(async () => {
  await __whenShimIdle(); // the previous test's fire-and-forget writes, finished
  await __resetFirestoreShim();
  __resetTriggerShim();
});

describe("get_uva_report", () => {
  it("is registered in the shared tool registry", () => {
    const def = TOOL_DEFINITIONS.find((t) => t.name === "get_uva_report");
    expect(def).toBeDefined();
    expect(def?.inputSchema.required).toEqual(["year", "period", "type"]);
  });

  it("returns the Kennzahlen the reports page shows for the same period", async () => {
    await seedCorpus();

    const page = await reportsPage(Q1);
    const tool = (await handleTool(USER, "get_uva_report", { ...Q1 })) as {
      period: Record<string, unknown>;
      kennzahlen: Record<string, number>;
      totalOutputVat: number;
      totalInputVat: number;
      balance: number;
      unresolved: unknown[];
    };

    const pageKennzahlen = Object.fromEntries(
      Object.entries(page.result.kennzahlen).map(([kz, f]) => [kz, f.value])
    );
    expect(tool.kennzahlen).toEqual(pageKennzahlen);
    expect(tool.totalOutputVat).toBe(page.result.totalOutputVat);
    expect(tool.totalInputVat).toBe(page.result.totalInputVat);
    expect(tool.balance).toBe(page.result.balance);
    expect(tool.unresolved).toEqual(page.result.unresolved);

    // The corpus is not trivially empty: the comparison compares something.
    expect(tool.totalInputVat).toBe(3000);
    expect(tool.totalOutputVat).toBe(1000);
    expect(tool.kennzahlen["095"]).toBe(-2000);
  });

  it("states the period the figures cover", async () => {
    await seedCorpus();
    const tool = (await handleTool(USER, "get_uva_report", { ...Q1 })) as {
      period: Record<string, unknown>;
    };
    expect(tool.period).toMatchObject({
      year: 2026,
      period: 1,
      type: "quarterly",
      start: "2026-01-01",
      end: "2026-03-31",
      timezone: "Europe/Vienna",
    });
  });

  it("returns zeroed figures and the period for a period with no data", async () => {
    const tool = (await handleTool(USER, "get_uva_report", {
      year: 2025,
      period: 7,
      type: "monthly",
    })) as {
      period: Record<string, unknown>;
      kennzahlen: Record<string, number>;
      totalOutputVat: number;
      totalInputVat: number;
      balance: number;
    };
    expect(tool.period).toMatchObject({ start: "2025-07-01", end: "2025-07-31" });
    expect(Object.values(tool.kennzahlen).every((v) => v === 0)).toBe(true);
    expect(tool.totalOutputVat).toBe(0);
    expect(tool.totalInputVat).toBe(0);
    expect(tool.balance).toBe(0);
  });

  it("does not read another user's transactions", async () => {
    await seedCorpus();
    const tool = (await handleTool("someone-else", "get_uva_report", { ...Q1 })) as {
      totalInputVat: number;
    };
    expect(tool.totalInputVat).toBe(0);
  });

  it("rejects a period the boundary math cannot express", async () => {
    await expect(
      handleTool(USER, "get_uva_report", { year: 2026, period: 5, type: "quarterly" })
    ).rejects.toThrow("A valid period is required");
    await expect(
      handleTool(USER, "get_uva_report", { year: 2026, period: 1 })
    ).rejects.toThrow("A valid period is required");
  });

  it("writes nothing", async () => {
    await seedCorpus();
    const before = JSON.stringify(
      (await db.collection("transactions").get()).docs.map((d) => [d.id, d.data()])
    );
    await handleTool(USER, "get_uva_report", { ...Q1 });
    const after = JSON.stringify(
      (await db.collection("transactions").get()).docs.map((d) => [d.id, d.data()])
    );
    expect(after).toBe(before);
  });
});
