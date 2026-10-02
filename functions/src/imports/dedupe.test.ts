import { describe, it, expect } from "vitest";
import type { Firestore } from "firebase-admin/firestore";
import { computeDedupeHash, findEarlierImportHashes, splitDuplicates, utcDay } from "./dedupe";

interface StoredTx {
  userId: string;
  sourceId: string;
  dedupeHash: string;
  importJobId?: string;
}

/** Minimal stand-in for the three-equality `in` query the module runs. */
function fakeDb(stored: StoredTx[]) {
  const queries: number[] = [];
  const db = {
    collection: () => {
      const filters: Array<[string, string, unknown]> = [];
      const q = {
        where(field: string, op: string, value: unknown) {
          filters.push([field, op, value]);
          return q;
        },
        async get() {
          const inFilter = filters.find(([, op]) => op === "in");
          queries.push((inFilter?.[2] as unknown[]).length);
          const docs = stored
            .filter((tx) =>
              filters.every(([field, op, value]) =>
                op === "==" ? (tx as unknown as Record<string, unknown>)[field] === value
                  : (value as unknown[]).includes((tx as unknown as Record<string, unknown>)[field])
              )
            )
            .map((tx) => ({ data: () => tx }));
          return { docs };
        },
      };
      return q;
    },
  };
  return { db: db as unknown as Firestore, queries };
}

describe("computeDedupeHash", () => {
  const base = { date: "2026-09-01", amount: -5420, sourceIdentifier: "AT61 1904 3002 3457 3201", reference: "RF48 0000" };

  it("is the web import's formula, so rows stored by the web import keep matching", () => {
    // Value produced by lib/import/deduplication.ts generateDedupeHash for the same inputs
    // (date 2026-09-01, -5420, "AT61 1904 3002 3457 3201", "RF48 0000"). If this changes, every
    // stored hash stops matching and the next import duplicates everything.
    expect(computeDedupeHash(base)).toBe("fdf7cb687408e4095e487e0db730db61495d025cdbddf1ff221f1b154e40a270");
  });

  it("ignores spacing and case in the IBAN and reference", () => {
    expect(computeDedupeHash(base)).toBe(
      computeDedupeHash({ ...base, sourceIdentifier: "at611904300234573201", reference: "  rf48 0000 " })
    );
  });

  it("reduces any date to its UTC calendar day", () => {
    expect(computeDedupeHash({ ...base, date: "2026-09-01T00:00:00.000Z" })).toBe(computeDedupeHash(base));
    expect(computeDedupeHash({ ...base, date: new Date(Date.UTC(2026, 8, 1)) })).toBe(computeDedupeHash(base));
    expect(utcDay("2026-09-01T23:59:59Z")).toBe("2026-09-01");
  });

  it("separates different amounts, days, accounts and references", () => {
    const h = computeDedupeHash(base);
    expect(computeDedupeHash({ ...base, amount: -5421 })).not.toBe(h);
    expect(computeDedupeHash({ ...base, date: "2026-09-02" })).not.toBe(h);
    expect(computeDedupeHash({ ...base, sourceIdentifier: "src-2" })).not.toBe(h);
    expect(computeDedupeHash({ ...base, reference: "other" })).not.toBe(h);
    expect(computeDedupeHash({ ...base, reference: null })).toBe(computeDedupeHash({ ...base, reference: "" }));
  });

  it("rejects an unreadable date instead of hashing 'Invalid Date'", () => {
    expect(() => computeDedupeHash({ ...base, date: "not a date" })).toThrow(/Invalid date/);
  });
});

describe("findEarlierImportHashes", () => {
  const stored: StoredTx[] = [
    { userId: "u1", sourceId: "s1", dedupeHash: "A", importJobId: "old" },
    { userId: "u1", sourceId: "s1", dedupeHash: "B", importJobId: "current" },
    { userId: "u1", sourceId: "s2", dedupeHash: "C", importJobId: "old" },
    { userId: "u2", sourceId: "s1", dedupeHash: "D", importJobId: "old" },
    { userId: "u1", sourceId: "s1", dedupeHash: "E" }, // e.g. a bank-sync row without an import job
  ];

  it("finds hashes of this user's, this account's earlier imports only", async () => {
    const { db } = fakeDb(stored);
    const found = await findEarlierImportHashes(db, "u1", "s1", ["A", "B", "C", "D", "E", "F"], "current");
    expect([...found].sort()).toEqual(["A", "E"]);
  });

  it("without a current import job, everything stored counts", async () => {
    const { db } = fakeDb(stored);
    const found = await findEarlierImportHashes(db, "u1", "s1", ["A", "B"]);
    expect([...found].sort()).toEqual(["A", "B"]);
  });

  it("queries in groups of 30 and skips repeated hashes", async () => {
    const { db, queries } = fakeDb([]);
    const hashes = Array.from({ length: 65 }, (_, i) => `h${i}`);
    await findEarlierImportHashes(db, "u1", "s1", [...hashes, ...hashes]);
    expect(queries).toEqual([30, 30, 5]);
  });
});

describe("splitDuplicates", () => {
  it("keeps identical rows of the same file, drops rows an earlier import holds", async () => {
    const { db } = fakeDb([{ userId: "u1", sourceId: "s1", dedupeHash: "OLD", importJobId: "earlier" }]);
    const rows = [
      { dedupeHash: "OLD", name: "already there" },
      { dedupeHash: "COFFEE", name: "coffee 1" },
      { dedupeHash: "COFFEE", name: "coffee 2" }, // same day, same amount, no reference: a second real payment
    ];
    const { fresh, duplicates } = await splitDuplicates(db, "u1", "s1", rows, "this-file");
    expect(duplicates.map((r) => r.name)).toEqual(["already there"]);
    expect(fresh.map((r) => r.name)).toEqual(["coffee 1", "coffee 2"]);
  });

  it("a second chunk of the same file does not see the first chunk as earlier", async () => {
    const { db } = fakeDb([{ userId: "u1", sourceId: "s1", dedupeHash: "COFFEE", importJobId: "this-file" }]);
    const { fresh, duplicates } = await splitDuplicates(db, "u1", "s1", [{ dedupeHash: "COFFEE" }], "this-file");
    expect(fresh).toHaveLength(1);
    expect(duplicates).toHaveLength(0);
  });
});
