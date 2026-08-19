/**
 * Fork #94: a dismissed file-to-transaction pair must survive a re-score.
 *
 * Dismissal used to be suppression by accident: the dismiss callable removed
 * the entry from `transactionSuggestions` and nothing re-scored the file, so
 * the pair stayed gone. Both retry-extraction paths rewrite that array, and
 * either one resurrected every dismissed pair at full confidence.
 *
 * `dismissedTransactionIds` (plus the newer `dismissedTransactions` object
 * form) is now the enforcement list, read off the file document the matcher
 * already holds.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// The matcher module calls getFirestore()/getAuth() at import time and
// registers a trigger, so the Firebase surface is swapped for an in-memory
// fake. Timestamp/FieldValue stay the real classes — scoring does date math
// on them.
const h = vi.hoisted(() => {
  const state = {
    transactions: [] as Array<{ id: string; data: Record<string, unknown> }>,
    partners: new Map<string, Record<string, unknown>>(),
    subscriptions: new Map<string, Record<string, unknown>>(),
    fileUpdates: [] as Record<string, unknown>[],
    writes: [] as Array<{ collection: string; data: Record<string, unknown> }>,
    passive: true,
    reads: 0,
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
    const q = {
      where: () => q,
      orderBy: () => q,
      limit: () => q,
      get: async () => {
        state.reads++;
        if (collection !== "transactions") return { docs: [], empty: true };
        const docs = state.transactions.map((t) => snap(t.id, t.data));
        return { docs, empty: docs.length === 0 };
      },
    };
    return q;
  };

  const collection = (name: string) => ({
    ...query(name),
    doc: (id: string) => ({
      id,
      get: async () => {
        state.reads++;
        if (name === "partners") return snap(id, state.partners.get(id));
        if (name === "subscriptions") return snap(id, state.subscriptions.get(id));
        return snap(id, undefined);
      },
      update: async (data: Record<string, unknown>) => {
        if (name === "files") state.fileUpdates.push(data);
      },
      set: async (data: Record<string, unknown>) => {
        state.writes.push({ collection: name, data });
      },
    }),
  });

  return {
    getFirestore: () => ({
      collection,
      batch: () => ({
        set: () => undefined,
        update: () => undefined,
        commit: async () => undefined,
      }),
    }),
    Timestamp: actual.Timestamp,
    FieldValue: actual.FieldValue,
  };
});

vi.mock("firebase-admin/auth", () => ({ getAuth: () => ({}) }));
vi.mock("firebase-functions/v2/firestore", () => ({
  onDocumentUpdated: () => ({}),
}));

// Passive mode stores suggestions and skips auto-connect, agentic workers and
// notifications — the shortest path through the matcher that still writes the
// suggestion list this ticket is about. Flipped off for the worker-queue test.
vi.mock("../../utils/checkAutomationMode", () => ({
  isPassiveMode: async () => h.state.passive,
}));

vi.mock("../../billing/checkAIBudget", () => ({
  checkAIBudget: async () => ({ allowed: true }),
}));

import { Timestamp } from "@google-cloud/firestore";
import { isActiveDismissal, readDismissedTransactionIds } from "../dismissedTransactions";
import { runTransactionMatching } from "../matchFileTransactions";

const USER = "u1";
const DATE = new Date("2026-07-01T00:00:00Z");

function tx(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    data: {
      userId: USER,
      date: Timestamp.fromDate(DATE),
      amount: -11900,
      currency: "EUR",
      name: "Hetzner Online GmbH",
      partner: "Hetzner Online GmbH",
      reference: "R0011223344",
      fileIds: [],
      ...over,
    },
  };
}

function file(over: Record<string, unknown> = {}) {
  return {
    userId: USER,
    fileName: "hetzner.pdf",
    extractionComplete: true,
    extractedAmount: 11900,
    extractedCurrency: "EUR",
    extractedDate: Timestamp.fromDate(DATE),
    extractedPartner: "Hetzner Online GmbH",
    extractedText: "Hetzner Online GmbH Rechnung R0011223344",
    transactionIds: [],
    ...over,
  };
}

/** The suggestion list written by the run, in stored order. */
function suggestionsWritten(): Array<{ transactionId: string; confidence: number }> {
  const last = h.state.fileUpdates.at(-1);
  return (last?.transactionSuggestions ?? []) as Array<{
    transactionId: string;
    confidence: number;
  }>;
}

beforeEach(() => {
  h.state.transactions = [];
  h.state.partners.clear();
  h.state.subscriptions.clear();
  h.state.fileUpdates = [];
  h.state.writes = [];
  h.state.passive = true;
  h.state.reads = 0;
});

describe("readDismissedTransactionIds", () => {
  it("is empty for a file that has never dismissed anything", () => {
    expect(readDismissedTransactionIds({}).size).toBe(0);
  });

  it("reads the legacy string array", () => {
    const ids = readDismissedTransactionIds({ dismissedTransactionIds: ["t1", "t2"] });
    expect([...ids].sort()).toEqual(["t1", "t2"]);
  });

  it("reads the object form written alongside it", () => {
    const ids = readDismissedTransactionIds({
      dismissedTransactions: [
        { transactionId: "t3", dismissedAt: Timestamp.fromDate(DATE), confidence: 91 },
      ],
    });
    expect([...ids]).toEqual(["t3"]);
  });

  it("unions both forms and ignores malformed entries", () => {
    const ids = readDismissedTransactionIds({
      dismissedTransactionIds: ["t1", "", null, 7],
      dismissedTransactions: [{ transactionId: "t2" }, {}, null, "t9"],
    });
    expect([...ids].sort()).toEqual(["t1", "t2"]);
  });

  it("skips a record whose rejection was taken back", () => {
    const ids = readDismissedTransactionIds({
      dismissedTransactions: [
        {
          transactionId: "t3",
          dismissedAt: Timestamp.fromDate(DATE),
          confidence: 91,
          undismissedAt: Timestamp.fromDate(DATE),
        },
      ],
    });
    expect(ids.size).toBe(0);
  });

  it("still suppresses when a standing rejection sits beside a reversed one", () => {
    const ids = readDismissedTransactionIds({
      dismissedTransactions: [
        {
          transactionId: "t3",
          dismissedAt: Timestamp.fromDate(DATE),
          undismissedAt: Timestamp.fromDate(DATE),
        },
        { transactionId: "t3", dismissedAt: Timestamp.fromDate(DATE) },
      ],
    });
    expect([...ids]).toEqual(["t3"]);
  });
});

describe("isActiveDismissal", () => {
  it("treats an unstamped record as still rejecting", () => {
    expect(isActiveDismissal({ transactionId: "t1" })).toBe(true);
    expect(isActiveDismissal({ transactionId: "t1", undismissedAt: null })).toBe(true);
  });

  it("treats a stamped record as history", () => {
    expect(isActiveDismissal({ transactionId: "t1", undismissedAt: Timestamp.fromDate(DATE) })).toBe(
      false
    );
  });

  it("does not throw on the malformed entries the readers tolerate", () => {
    expect(isActiveDismissal(null)).toBe(true);
    expect(isActiveDismissal("t9")).toBe(true);
  });
});

describe("runTransactionMatching: dismissal survives a re-score", () => {
  it("does not re-propose a pair the file dismissed", async () => {
    h.state.transactions = [tx("t-dismissed")];

    await runTransactionMatching("f1", file({ dismissedTransactionIds: ["t-dismissed"] }));

    expect(suggestionsWritten()).toEqual([]);
    expect(h.state.fileUpdates.at(-1)?.transactionMatchComplete).toBe(true);
  });

  it("re-proposes the same pair when it was never dismissed", async () => {
    h.state.transactions = [tx("t-dismissed")];

    await runTransactionMatching("f1", file());

    expect(suggestionsWritten().map((s) => s.transactionId)).toEqual(["t-dismissed"]);
  });

  it("honours the object form of the dismissal record", async () => {
    h.state.transactions = [tx("t-dismissed")];

    await runTransactionMatching(
      "f1",
      file({
        dismissedTransactions: [
          { transactionId: "t-dismissed", dismissedAt: Timestamp.fromDate(DATE), confidence: 88 },
        ],
      })
    );

    expect(suggestionsWritten()).toEqual([]);
  });

  it("proposes the pair again once the rejection has been taken back", async () => {
    h.state.transactions = [tx("t-dismissed")];

    // Exactly the document shape undo leaves behind: off the enforcement list,
    // still on the record with a stamp. This is the acceptance criterion for
    // fork #95 — undo's promise is "eligible to be suggested again", and this
    // is the only place it can be proved.
    await runTransactionMatching(
      "f1",
      file({
        dismissedTransactionIds: [],
        dismissedTransactions: [
          {
            transactionId: "t-dismissed",
            dismissedAt: Timestamp.fromDate(DATE),
            confidence: 88,
            undismissedAt: Timestamp.fromDate(DATE),
          },
        ],
      })
    );

    expect(suggestionsWritten().map((s) => s.transactionId)).toEqual(["t-dismissed"]);
  });

  it("keeps suppressing after undo when the pair was rejected a second time", async () => {
    h.state.transactions = [tx("t-dismissed")];

    await runTransactionMatching(
      "f1",
      file({
        dismissedTransactionIds: ["t-dismissed"],
        dismissedTransactions: [
          {
            transactionId: "t-dismissed",
            dismissedAt: Timestamp.fromDate(DATE),
            confidence: 88,
            undismissedAt: Timestamp.fromDate(DATE),
          },
          {
            transactionId: "t-dismissed",
            dismissedAt: Timestamp.fromDate(DATE),
            confidence: 88,
          },
        ],
      })
    );

    expect(suggestionsWritten()).toEqual([]);
  });

  it("leaves the other candidates proposed with unchanged scores", async () => {
    h.state.transactions = [
      tx("t-dismissed"),
      tx("t-keep", { name: "Hetzner Online GmbH", reference: "R0011223399" }),
    ];

    await runTransactionMatching("f1", file());
    const before = suggestionsWritten().find((s) => s.transactionId === "t-keep");

    h.state.fileUpdates = [];
    await runTransactionMatching("f1", file({ dismissedTransactionIds: ["t-dismissed"] }));
    const after = suggestionsWritten();

    expect(after.map((s) => s.transactionId)).toEqual(["t-keep"]);
    expect(after[0].confidence).toBe(before!.confidence);
  });

  it("tells the agentic fallback worker what the file already rejected", async () => {
    // Filtering the only strong candidate out leaves the file looking
    // unmatched, which queues the agentic search. That worker connects through
    // connectFileToTransaction, which has no dismissal check of its own.
    h.state.passive = false;
    h.state.transactions = [tx("t-dismissed")];

    await runTransactionMatching("f1", file({ dismissedTransactionIds: ["t-dismissed"] }));

    const request = h.state.writes.find((w) => w.collection.endsWith("workerRequests"));
    expect(request).toBeDefined();
    expect(
      (request!.data.triggerContext as { dismissedTransactionIds: string[] })
        .dismissedTransactionIds
    ).toEqual(["t-dismissed"]);
    expect(request!.data.initialPrompt).toContain("Do NOT connect these transactions");
    expect(request!.data.initialPrompt).toContain("t-dismissed");
  });

  it("adds no Firestore read to the scoring path", async () => {
    h.state.transactions = [tx("t-dismissed"), tx("t-keep")];

    await runTransactionMatching("f1", file());
    const readsWithout = h.state.reads;

    h.state.reads = 0;
    await runTransactionMatching("f1", file({ dismissedTransactionIds: ["t-dismissed"] }));

    expect(h.state.reads).toBe(readsWithout);
  });
});
