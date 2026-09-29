/**
 * #139, the forwards half: a Transaction's Partner changing must refresh the
 * `transactionSuggestions` of the affected Partners' unconnected Files.
 *
 * Decision (Felix, 2026-09-27): batch re-scoring once per affected Partner at
 * the end of applyPartnerMatchUpdates and rematchAssignedPartners. Scope: only
 * unconnected Files of the old and the new Partner. Suggestions only, never
 * auto-connect. Reuses scoreTransaction the way rescoreFileConnections.ts does.
 */

import { describe, it, expect } from "vitest";
import { Timestamp } from "firebase-admin/firestore";
import { rescoreUnconnectedFilesForPartners } from "../rescorePartnerFiles";

interface Row {
  id: string;
  data: Record<string, unknown>;
}

interface FakeUpdate {
  ref: { id: string; collection: string };
  data: Record<string, unknown>;
}

/**
 * A fake Firestore serving canned rows per collection. Filters are ignored:
 * the module under test narrows candidates in memory, and what this fake pins
 * is which documents get written, with what, and that nothing is created.
 */
function fakeDb(rows: { files: Row[]; transactions: Row[]; partners: Row[] }) {
  const updates: FakeUpdate[] = [];
  const sets: unknown[] = [];
  let commits = 0;
  const queried: string[] = [];

  const toDoc = (collection: string) => (row: Row) => ({
    id: row.id,
    ref: { id: row.id, collection },
    data: () => row.data,
  });

  function makeCollection(name: string) {
    const query = {
      where: () => query,
      orderBy: () => query,
      limit: () => query,
      get: async () => {
        queried.push(name);
        const list = (rows as Record<string, Row[]>)[name] ?? [];
        return { docs: list.map(toDoc(name)), empty: list.length === 0, size: list.length };
      },
      doc: (id: string) => ({
        id,
        get: async () => {
          const list = (rows as Record<string, Row[]>)[name] ?? [];
          const row = list.find((r) => r.id === id);
          return { exists: Boolean(row), id, data: () => row?.data };
        },
      }),
    };
    return query;
  }

  const db = {
    collection: (name: string) => makeCollection(name),
    batch: () => ({
      update: (ref: FakeUpdate["ref"], data: Record<string, unknown>) => {
        updates.push({ ref, data });
      },
      set: (...args: unknown[]) => {
        sets.push(args);
      },
      commit: async () => {
        commits++;
      },
    }),
  } as unknown as FirebaseFirestore.Firestore;

  return { db, updates, sets, queried, commitCount: () => commits };
}

const ts = (iso: string) => Timestamp.fromDate(new Date(iso));

const partner = (id: string): Row => ({
  id,
  data: { userId: "u1", name: "Acme GmbH", aliases: [] },
});

const baseFile = (id: string, extra: Record<string, unknown> = {}): Row => ({
  id,
  data: {
    userId: "u1",
    partnerId: "p1",
    transactionMatchComplete: true,
    extractedAmount: 1000,
    extractedCurrency: "EUR",
    extractedDate: ts("2026-01-05"),
    extractedPartner: "Acme",
    transactionSuggestions: [],
    ...extra,
  },
});

const t1: Row = {
  id: "t1",
  data: {
    userId: "u1",
    amount: -1000,
    currency: "EUR",
    date: ts("2026-01-06"),
    name: "Acme GmbH 4711",
    partnerId: "p1",
  },
};

describe("rescoreUnconnectedFilesForPartners", () => {
  it("refreshes the suggestions of an unconnected File of the Partner", async () => {
    const { db, updates, sets } = fakeDb({
      files: [baseFile("f1")],
      transactions: [t1],
      partners: [partner("p1")],
    });

    const result = await rescoreUnconnectedFilesForPartners(db, "u1", ["p1"]);

    expect(result.filesRescored).toBe(1);
    expect(updates).toHaveLength(1);
    expect(updates[0].ref.id).toBe("f1");

    const suggestions = updates[0].data.transactionSuggestions as Array<{
      transactionId: string;
      confidence: number;
      matchSources: string[];
    }>;
    expect(suggestions[0].transactionId).toBe("t1");
    // The whole point of #139: the Partner now assigned to the Transaction
    // contributes, so the pair clears the suggestion threshold.
    expect(suggestions[0].confidence).toBeGreaterThanOrEqual(50);
    expect(suggestions[0].matchSources).toContain("partner");

    // Suggestions only, never auto-connect: nothing is created, and neither
    // the File's connections nor its pipeline flags are touched.
    expect(sets).toHaveLength(0);
    expect(updates[0].data).not.toHaveProperty("transactionIds");
    expect(updates[0].data).not.toHaveProperty("transactionMatchComplete");
  });

  it("leaves connected Files alone", async () => {
    const { db, updates } = fakeDb({
      files: [baseFile("f-connected", { transactionIds: ["t9"] })],
      transactions: [t1],
      partners: [partner("p1")],
    });

    const result = await rescoreUnconnectedFilesForPartners(db, "u1", ["p1"]);

    expect(result.filesRescored).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("never resurrects a dismissed pair", async () => {
    const { db, updates } = fakeDb({
      files: [baseFile("f1", { dismissedTransactionIds: ["t1"] })],
      transactions: [t1],
      partners: [partner("p1")],
    });

    await rescoreUnconnectedFilesForPartners(db, "u1", ["p1"]);

    expect(updates).toHaveLength(1);
    expect(updates[0].data.transactionSuggestions).toEqual([]);
  });

  it("skips deleted, not-invoice and foreign-recipient Files", async () => {
    const { db, updates } = fakeDb({
      files: [
        baseFile("f-deleted", { deletedAt: ts("2026-01-01") }),
        baseFile("f-not-invoice", { isNotInvoice: true }),
        baseFile("f-foreign", { foreignRecipient: true }),
      ],
      transactions: [t1],
      partners: [partner("p1")],
    });

    const result = await rescoreUnconnectedFilesForPartners(db, "u1", ["p1"]);

    expect(result.filesRescored).toBe(0);
    expect(updates).toHaveLength(0);
  });

  it("processes each affected Partner once", async () => {
    const { db, queried } = fakeDb({
      files: [],
      transactions: [],
      partners: [partner("p1")],
    });

    const result = await rescoreUnconnectedFilesForPartners(db, "u1", [
      "p1",
      "p1",
      "",
    ]);

    expect(result.partnersProcessed).toBe(1);
    expect(queried.filter((c) => c === "files")).toHaveLength(1);
  });
});
