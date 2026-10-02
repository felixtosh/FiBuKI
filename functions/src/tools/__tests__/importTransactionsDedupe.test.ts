/**
 * import_transactions skips what an earlier import already stored, on the
 * server, for every caller (MCP, REST, the plugin's CSV script). The clients
 * used to be the only place that checked, and the tool never did, so an
 * overlapping bank export duplicated every line.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { store, createMockFirestore, createTestSource } from "../../test/setup";

vi.mock("firebase-admin/firestore", () => {
  class MockTimestamp {
    constructor(private readonly date: Date) {}
    static fromDate(d: Date) {
      return new MockTimestamp(d);
    }
    static now() {
      return new MockTimestamp(new Date());
    }
    toDate() {
      return this.date;
    }
    valueOf() {
      return this.date.getTime();
    }
  }
  return {
    getFirestore: () => createMockFirestore(),
    FieldValue: { serverTimestamp: () => new Date(), increment: (n: number) => n },
    Timestamp: MockTimestamp,
  };
});

vi.mock("firebase-admin/storage", () => ({ getStorage: () => ({ bucket: () => ({}) }) }));
vi.mock("firebase-functions/params", () => ({
  defineSecret: (name: string) => ({ value: () => `test-${name}` }),
}));
vi.mock("../../billing/checkTransactionQuota", () => ({
  checkTransactionQuota: async (_userId: string, count: number) => ({
    allowed: true,
    currentCount: 0,
    limit: Infinity,
    remainingSlots: Infinity,
    count,
  }),
  incrementTransactionCount: async () => undefined,
}));

const handlers = await import("../handlers");
const { computeDedupeHash } = await import("../../imports/dedupe");

const userId = "user-dedupe";
const IBAN = "AT611904300234573201";

const row = (date: string, amount: number, name: string, extra: Record<string, unknown> = {}) => ({
  date,
  amount,
  currency: "EUR",
  name,
  ...extra,
});

function stored(sourceId?: string) {
  return [...store.getCollection("transactions").values()].filter(
    (t) => !sourceId || t.sourceId === sourceId
  );
}

async function importRows(rows: unknown[], extra: Record<string, unknown> = {}, sourceId = "s1") {
  return (await handlers.handleTool(userId, "import_transactions", {
    sourceId,
    transactions: rows,
    ...extra,
  })) as { count: number; duplicateCount: number; transactionIds: string[] };
}

describe("import_transactions dedupe", () => {
  beforeEach(() => {
    store.clear();
    store.setDoc("sources", "s1", createTestSource({ userId, iban: IBAN }));
    store.setDoc("sources", "card", createTestSource({ userId, iban: undefined, accountKind: "credit_card" }));
    store.setDoc("sources", "s2", createTestSource({ userId, iban: "AT483200000012345864" }));
  });

  const september = [
    row("2026-09-01", -5420, "REWE"),
    row("2026-09-03", -3990, "A1", { reference: "RF48 0000 1122 33" }),
    row("2026-09-15", 341255, "Honorar"),
  ];

  it("imports new rows and stores the same hash the web import stores", async () => {
    const result = await importRows(september);
    expect(result.count).toBe(3);
    expect(result.duplicateCount).toBe(0);

    const a1 = stored("s1").find((t) => t.name === "A1");
    expect(a1?.dedupeHash).toBe(
      computeDedupeHash({ date: "2026-09-03", amount: -3990, sourceIdentifier: IBAN, reference: "RF48 0000 1122 33" })
    );
  });

  it("uses the account id as identifier for an account without an IBAN (credit cards)", async () => {
    await importRows([row("2026-09-01", -100, "Kaffee")], {}, "card");
    expect(stored("card")[0].dedupeHash).toBe(
      computeDedupeHash({ date: "2026-09-01", amount: -100, sourceIdentifier: "card" })
    );
  });

  it("re-importing the same export creates nothing and says how many it skipped", async () => {
    await importRows(september);
    const again = await importRows(september);
    expect(again.count).toBe(0);
    expect(again.duplicateCount).toBe(3);
    expect(stored("s1")).toHaveLength(3);
  });

  it("an overlapping export adds only the new lines", async () => {
    await importRows(september.slice(0, 2));
    const next = await importRows([...september, row("2026-09-20", -980, "Miete")]);
    expect(next.count).toBe(2);
    expect(next.duplicateCount).toBe(2);
    expect(stored("s1").map((t) => t.name).sort()).toEqual(["A1", "Honorar", "Miete", "REWE"]);
  });

  it("keeps identical lines of one file, even when they arrive in different chunks", async () => {
    const coffee = row("2026-09-05", -350, "Cafe Central");
    await importRows([coffee], { importJobId: "api_csv_file1" });
    const second = await importRows([coffee], { importJobId: "api_csv_file1" });
    expect(second.count).toBe(1);
    expect(second.duplicateCount).toBe(0);
    expect(stored("s1")).toHaveLength(2);

    // ...but the same file imported again later, as a new import, is skipped as a whole.
    const later = await importRows([coffee, coffee], { importJobId: "api_csv_file2" });
    expect(later.count).toBe(0);
    expect(later.duplicateCount).toBe(2);
  });

  it("identical lines in one first-time call are all kept", async () => {
    const coffee = row("2026-09-05", -350, "Cafe Central");
    const result = await importRows([coffee, coffee]);
    expect(result.count).toBe(2);
    expect(result.duplicateCount).toBe(0);
  });

  it("another Bank Account or another user never counts as a duplicate", async () => {
    await importRows(september);
    store.setDoc("transactions", "foreign", {
      userId: "someone-else",
      sourceId: "s1",
      dedupeHash: computeDedupeHash({ date: "2026-09-20", amount: -980, sourceIdentifier: IBAN }),
      importJobId: "x",
    });

    const otherAccount = await importRows(september, {}, "s2");
    expect(otherAccount.count).toBe(3);

    const miete = await importRows([row("2026-09-20", -980, "Miete")]);
    expect(miete.count).toBe(1);
    expect(miete.duplicateCount).toBe(0);
  });

  it("returns an empty result, not an error, when everything is a duplicate", async () => {
    await importRows(september);
    const again = await importRows(september.slice(0, 1));
    expect(again).toMatchObject({ success: true, count: 0, duplicateCount: 1, transactionIds: [] });
  });
});
