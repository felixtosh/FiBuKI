/**
 * When a Remainder Match may connect itself (#242).
 *
 * #239 made a Match scored against a Transaction's Remainder a suggestion
 * whatever its Confidence. #242 opens one exception: the documents are from
 * the same day, and no Transaction holding nothing wants the File at least as
 * much. The pair it exists for is the split part-invoice — a 500,00 bank line
 * already carrying a 285,80 invoice, and a 214,20 document from the same day
 * that closes it. The hazard it has to survive is the two-receipts-one-day
 * case, where a greedy per-File score would put receipt B on Transaction A's
 * Remainder while B's own Transaction sits empty beside it.
 *
 * The matcher calls getFirestore()/getAuth() at import time and registers a
 * trigger, so the Firebase surface is swapped for an in-memory fake, the same
 * shape dismissedSuggestions.test.ts uses. Timestamp/FieldValue stay real —
 * scoring does date math on them.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => {
  const state = {
    transactions: [] as Array<{ id: string; data: Record<string, unknown> }>,
    files: new Map<string, Record<string, unknown>>(),
    fileUpdates: [] as Record<string, unknown>[],
    batchWrites: [] as Array<{ collection: string; data: Record<string, unknown> }>,
  };
  return { state };
});

vi.mock("firebase-admin/firestore", async () => {
  const actual = await import("@google-cloud/firestore");
  const { state } = h;

  const snap = (id: string, data: Record<string, unknown> | undefined) => ({
    id,
    exists: data !== undefined,
    data: () => data,
  });

  const query = (collection: string) => {
    // Two filtered reads matter here, both inside loadConnectedFiles:
    // `where("transactionId", "in", [...])` over fileConnections, and
    // `where("__name__", "in", [...])` over the files those name. Everything
    // else is answered from the seeded state regardless of the clauses.
    let ids: string[] | null = null;
    let transactionIds: string[] | null = null;
    const q = {
      where: (field: string, _op: string, value: unknown) => {
        if (field === "__name__") ids = value as string[];
        if (field === "transactionId") transactionIds = value as string[];
        return q;
      },
      orderBy: () => q,
      limit: () => q,
      get: async () => {
        if (collection === "transactions") {
          const docs = state.transactions.map((t) => snap(t.id, t.data));
          return { docs, empty: docs.length === 0 };
        }
        if (collection === "fileConnections") {
          // Connections are materialised from the `fileIds` a test seeds on its
          // transactions: one row per connected File, which is the shape
          // production stores. The seed stays readable, and the code under test
          // still goes through the real `fileConnections` read.
          const wanted = transactionIds;
          const docs = state.transactions
            .filter((t) => !wanted || wanted.includes(t.id))
            .flatMap((t) =>
              ((t.data.fileIds as string[] | undefined) ?? []).map((fileId) =>
                snap(`${t.id}:${fileId}`, { transactionId: t.id, fileId })
              )
            );
          return { docs, empty: docs.length === 0 };
        }
        if (collection === "files" && ids) {
          const docs = ids
            .filter((id) => state.files.has(id))
            .map((id) => snap(id, state.files.get(id)));
          return { docs, empty: docs.length === 0 };
        }
        return { docs: [], empty: true };
      },
    };
    return q;
  };

  const docRef = (collection: string, id: string) => ({
    id,
    _collection: collection,
    get: async () => {
      if (collection === "files") return snap(id, state.files.get(id));
      if (collection === "transactions") {
        return snap(id, state.transactions.find((t) => t.id === id)?.data);
      }
      return snap(id, undefined);
    },
    update: async (data: Record<string, unknown>) => {
      if (collection === "files") state.fileUpdates.push(data);
    },
    set: async () => undefined,
  });

  const collection = (name: string) => ({
    ...query(name),
    doc: (id?: string) => docRef(name, id ?? `generated-${state.batchWrites.length}`),
    add: async () => ({ id: "notification" }),
  });

  return {
    getFirestore: () => ({
      collection,
      batch: () => ({
        set: (ref: { _collection: string }, data: Record<string, unknown>) => {
          state.batchWrites.push({ collection: ref._collection, data });
        },
        update: (ref: { _collection: string }, data: Record<string, unknown>) => {
          if (ref._collection === "files") state.fileUpdates.push(data);
        },
        commit: async () => undefined,
      }),
    }),
    Timestamp: actual.Timestamp,
    FieldValue: actual.FieldValue,
  };
});

vi.mock("firebase-admin/auth", () => ({
  getAuth: () => ({ getUser: async () => ({ customClaims: {} }) }),
}));
vi.mock("firebase-functions/v2/firestore", () => ({
  onDocumentUpdated: () => ({}),
}));

// Active mode: the auto-connect decision this test is about actually runs.
vi.mock("../../utils/checkAutomationMode", () => ({
  isPassiveMode: async () => false,
}));

// Budget exhausted: the rule-based scoring above is free and unaffected, and
// the agentic follow-up stays out of the way.
vi.mock("../../billing/checkAIBudget", () => ({
  checkAIBudget: async () => ({ allowed: false }),
}));

import { Timestamp } from "@google-cloud/firestore";
import { runTransactionMatching } from "../matchFileTransactions";
import {
  extractedDayKey,
  isSameDayEvidence,
  hasUndocumentedRival,
} from "../remainderAutoConnect";

const USER = "u1";
const DATE = new Date("2026-07-01T00:00:00Z");
const NEXT_DAY = new Date("2026-07-02T00:00:00Z");

function tx(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    data: {
      userId: USER,
      date: Timestamp.fromDate(DATE),
      amount: -50000,
      currency: "EUR",
      name: "Hetzner Online GmbH",
      partner: "Hetzner Online GmbH",
      fileIds: [],
      ...over,
    },
  };
}

/** The 214,20 candidate: same day, same partner name, closes the remainder. */
function candidate(over: Record<string, unknown> = {}) {
  return {
    userId: USER,
    fileName: "hetzner-part-2.pdf",
    extractionComplete: true,
    extractedAmount: 21420,
    extractedCurrency: "EUR",
    extractedDate: Timestamp.fromDate(DATE),
    extractedPartner: "Hetzner Online GmbH",
    transactionIds: [],
    ...over,
  };
}

function suggestionsWritten(): Array<{
  transactionId: string;
  confidence: number;
  matchSources: string[];
}> {
  const withSuggestions = h.state.fileUpdates.filter((u) => u.transactionSuggestions);
  return (withSuggestions.at(-1)?.transactionSuggestions ?? []) as Array<{
    transactionId: string;
    confidence: number;
    matchSources: string[];
  }>;
}

function connectionsCreated() {
  return h.state.batchWrites.filter((w) => w.collection === "fileConnections");
}

function connectedTransactionIds(): string[] {
  return connectionsCreated().map((c) => c.data.transactionId as string);
}

beforeEach(() => {
  h.state.transactions = [];
  h.state.files.clear();
  h.state.fileUpdates = [];
  h.state.batchWrites = [];
});

// ============================================================================
// The rule itself
// ============================================================================

describe("isSameDayEvidence", () => {
  const day = (d: string) => Timestamp.fromDate(new Date(`${d}T00:00:00Z`));

  it("holds when the candidate carries the day every connected file carries", () => {
    expect(isSameDayEvidence(day("2026-07-01"), [day("2026-07-01")])).toBe(true);
    expect(
      isSameDayEvidence(day("2026-07-01"), [day("2026-07-01"), day("2026-07-01")])
    ).toBe(true);
  });

  it("fails on one day's distance — same day means same day", () => {
    expect(isSameDayEvidence(day("2026-07-02"), [day("2026-07-01")])).toBe(false);
    expect(
      isSameDayEvidence(day("2026-07-01"), [day("2026-07-01"), day("2026-06-30")])
    ).toBe(false);
  });

  it("fails when any date is unknown — unknown is not same-day", () => {
    expect(isSameDayEvidence(null, [day("2026-07-01")])).toBe(false);
    expect(isSameDayEvidence(day("2026-07-01"), [null])).toBe(false);
    expect(isSameDayEvidence(day("2026-07-01"), [day("2026-07-01"), undefined])).toBe(false);
  });

  it("fails when the transaction holds nothing: that is not a remainder case", () => {
    expect(isSameDayEvidence(day("2026-07-01"), [])).toBe(false);
  });

  it("reads the day in UTC, where an extracted date is put", () => {
    // A date stored as the printed day's midnight keeps that day whatever zone
    // the container runs in.
    expect(extractedDayKey(day("2026-07-01"))).toBe("2026-07-01");
    expect(extractedDayKey(null)).toBeNull();
  });
});

describe("hasUndocumentedRival", () => {
  const holdsFiles = (id: string) => id === "t-split";

  it("finds an empty transaction that scores at least as well", () => {
    const match = { transactionId: "t-split", confidence: 90 };
    const rival = { transactionId: "t-open", confidence: 90 };
    // A tie goes to the line that explains nothing yet.
    expect(hasUndocumentedRival(match, [match, rival], holdsFiles)).toBe(true);
  });

  it("ignores an empty transaction that scores below it", () => {
    const match = { transactionId: "t-split", confidence: 90 };
    const rival = { transactionId: "t-open", confidence: 89 };
    expect(hasUndocumentedRival(match, [match, rival], holdsFiles)).toBe(false);
  });

  it("ignores a rival that already holds files of its own", () => {
    const match = { transactionId: "t-split", confidence: 90 };
    const rival = { transactionId: "t-split-2", confidence: 95 };
    expect(
      hasUndocumentedRival(match, [match, rival], (id) => id.startsWith("t-split"))
    ).toBe(false);
  });
});

// ============================================================================
// The rule in the matcher
// ============================================================================

describe("runTransactionMatching: a same-day remainder match connects itself (#242)", () => {
  beforeEach(() => {
    // 500,00 line with a 285,80 invoice from 1 July already on it: 214,20 open.
    h.state.transactions = [tx("t-split", { fileIds: ["f-existing"] })];
    h.state.files.set("f-existing", {
      userId: USER,
      extractedAmount: 28580,
      extractedCurrency: "EUR",
      extractedDate: Timestamp.fromDate(DATE),
    });
  });

  it("auto-connects a file dated the same day as the file already on the line", async () => {
    await runTransactionMatching("f-candidate", candidate());

    expect(connectedTransactionIds()).toEqual(["t-split"]);
    expect(suggestionsWritten()[0].matchSources).toContain("amount_remainder");
  });

  it("says on the stored connection why it was allowed to", async () => {
    await runTransactionMatching("f-candidate", candidate());

    const connection = connectionsCreated()[0].data;
    expect(connection.autoConnectReason).toBe("remainder_same_day");
    expect(connection.matchSources).toContain("amount_remainder");
    // The figure it was judged against, so a wrong one can be read back.
    expect(
      (connection.scoreBreakdown as { scoredAgainstRemainder?: number }).scoredAgainstRemainder
    ).toBe(21420);
  });

  it("suggests, but does not connect, the same file dated one day later", async () => {
    await runTransactionMatching(
      "f-candidate",
      candidate({ extractedDate: Timestamp.fromDate(NEXT_DAY) })
    );

    // Still well past the auto-match threshold: it is the dates that hold it
    // back, not the Confidence.
    const suggested = suggestionsWritten();
    expect(suggested.map((s) => s.transactionId)).toEqual(["t-split"]);
    expect(suggested[0].confidence).toBeGreaterThanOrEqual(85);
    expect(connectionsCreated()).toEqual([]);
    expect(h.state.fileUpdates.some((u) => u.transactionIds)).toBe(false);
  });

  it("never connects a file whose amount does not close the remainder", async () => {
    // Same day, same partner, and the bank line prints the invoice number:
    // 37 + 25 + 50 reaches 100% with no amount points at all. A 50,00 document
    // against a 214,20 Remainder explains none of what is open, so it is not
    // the split this permission exists for and stays a suggestion.
    h.state.transactions = [
      tx("t-split", {
        fileIds: ["f-existing"],
        description: "RECHNUNG 4711002356 HETZNER",
      }),
    ];

    await runTransactionMatching(
      "f-candidate",
      candidate({ extractedAmount: 5000, extractedInvoiceNumber: "4711002356" })
    );

    expect(suggestionsWritten()[0].confidence).toBeGreaterThanOrEqual(85);
    expect(connectionsCreated()).toEqual([]);
  });

  it("connects one that closes the remainder within the tolerance, not only an exact hit", async () => {
    // 10,00 line carrying a 4,20 receipt: 5,80 open, and a 5,00 document from
    // the same day. Eighty cents is the rounding-or-Trinkgeld gap
    // REMAINDER_CLOSE_TOLERANCE forgives, so this is a closed Remainder.
    h.state.transactions = [tx("t-split", { amount: -1000, fileIds: ["f-existing"] })];
    h.state.files.set("f-existing", {
      userId: USER,
      extractedAmount: 420,
      extractedCurrency: "EUR",
      extractedDate: Timestamp.fromDate(DATE),
    });

    await runTransactionMatching("f-candidate", candidate({ extractedAmount: 500 }));

    expect(connectedTransactionIds()).toEqual(["t-split"]);
    expect(connectionsCreated()[0].data.autoConnectReason).toBe("remainder_same_day");
  });

  it("never connects a file with no extracted date", async () => {
    // A part-invoice whose number the bank line prints: 40 + 50 clears the
    // threshold with no date at all. Unknown is not same-day, so it stays a
    // suggestion.
    h.state.transactions = [
      tx("t-split", {
        fileIds: ["f-existing"],
        description: "RECHNUNG 4711002356 HETZNER",
      }),
    ];

    await runTransactionMatching(
      "f-candidate",
      candidate({ extractedDate: null, extractedInvoiceNumber: "4711002356" })
    );

    expect(suggestionsWritten()[0].confidence).toBeGreaterThanOrEqual(85);
    expect(connectionsCreated()).toEqual([]);
  });

  it("never connects when a file already on the line has no extracted date", async () => {
    h.state.files.set("f-existing", {
      userId: USER,
      extractedAmount: 28580,
      extractedCurrency: "EUR",
    });

    await runTransactionMatching("f-candidate", candidate());

    expect(suggestionsWritten()[0].confidence).toBeGreaterThanOrEqual(85);
    expect(connectionsCreated()).toEqual([]);
  });

  it("scores a fully documented line on its full amount again", async () => {
    h.state.files.set("f-existing", {
      userId: USER,
      extractedAmount: 50000,
      extractedCurrency: "EUR",
      extractedDate: Timestamp.fromDate(DATE),
    });

    await runTransactionMatching("f-candidate", candidate());

    // Nothing is left over, so the 214,20 is judged against the whole 500,00
    // and earns no amount points at all. It survives on date and partner, and
    // is not a Remainder Match — the Coverage gate keeps it from connecting.
    const suggested = suggestionsWritten();
    expect(suggested.map((s) => s.transactionId)).toEqual(["t-split"]);
    expect(suggested[0].matchSources).not.toContain("amount_remainder");
    expect(suggested[0].matchSources).not.toContain("amount_exact");
    expect(connectionsCreated()).toEqual([]);
  });
});

describe("runTransactionMatching: never over an undocumented transaction (#242)", () => {
  it("prefers the empty line and leaves the remainder a suggestion", async () => {
    // The same 214,20 document could close t-split's remainder or explain
    // t-open outright. The line that explains nothing yet wins.
    h.state.transactions = [
      tx("t-split", { fileIds: ["f-existing"] }),
      tx("t-open", { amount: -21420 }),
    ];
    h.state.files.set("f-existing", {
      userId: USER,
      extractedAmount: 28580,
      extractedCurrency: "EUR",
      extractedDate: Timestamp.fromDate(DATE),
    });

    await runTransactionMatching("f-candidate", candidate());

    expect(connectedTransactionIds()).toEqual(["t-open"]);
    expect(connectionsCreated()[0].data.autoConnectReason).toBeUndefined();
    // The remainder match is still on the file for the user to accept.
    expect(suggestionsWritten().map((s) => s.transactionId)).toContain("t-split");
  });

  it("puts two same-day receipts on two same-day transactions, not both on one", async () => {
    // 50,00 card payment already carrying the 30,00 receipt A, and a second
    // 20,00 card payment from the same day holding nothing. Receipt B closes
    // A's remainder exactly — and is B's own line's whole amount.
    h.state.transactions = [
      tx("t-a", { amount: -5000, name: "REWE", partner: "REWE", fileIds: ["f-receipt-a"] }),
      tx("t-b", { amount: -2000, name: "REWE", partner: "REWE" }),
    ];
    h.state.files.set("f-receipt-a", {
      userId: USER,
      extractedAmount: 3000,
      extractedCurrency: "EUR",
      extractedDate: Timestamp.fromDate(DATE),
    });

    await runTransactionMatching(
      "f-receipt-b",
      candidate({
        fileName: "rewe-2.pdf",
        extractedAmount: 2000,
        extractedPartner: "REWE",
      })
    );

    expect(connectedTransactionIds()).toEqual(["t-b"]);
  });
});

describe("runTransactionMatching: full-amount auto-connect is unchanged (#242)", () => {
  it("still auto-connects a file to a line that holds nothing", async () => {
    h.state.transactions = [tx("t-open", { amount: -21420 })];

    await runTransactionMatching("f-candidate", candidate());

    expect(connectedTransactionIds()).toEqual(["t-open"]);
    const connection = connectionsCreated()[0].data;
    // Not a remainder connection: the record says nothing new about it.
    expect(connection.autoConnectReason).toBeUndefined();
    expect(connection.connectionType).toBe("auto_matched");
    expect(connection.matchSources).not.toContain("amount_remainder");
  });

  it("still refuses a line already covered by what sits on it", async () => {
    // 95% documented: past COVERAGE_RATIO, so no further file connects itself,
    // same-day or not.
    h.state.transactions = [tx("t-covered", { amount: -30000, fileIds: ["f-existing"] })];
    h.state.files.set("f-existing", {
      userId: USER,
      extractedAmount: 28580,
      extractedCurrency: "EUR",
      extractedDate: Timestamp.fromDate(DATE),
    });

    await runTransactionMatching("f-candidate", candidate({ extractedAmount: 1420 }));

    expect(connectionsCreated()).toEqual([]);
  });
});
