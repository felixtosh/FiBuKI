/**
 * Fork #94, third enforcement path: the on-demand match lookup.
 *
 * findTransactionMatchesForFile is what the UI's refresh-matches action calls
 * (lib/operations/file-transaction-matching-ops.ts), and its top result is
 * auto-connected at AUTO_MATCH_THRESHOLD — so pressing refresh used to undo a
 * rejection made seconds earlier.
 *
 * An explicit searchQuery is deliberately exempt: it is the only way back to a
 * dismissed pair by hand, and dismissal is not meant to be irreversible.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  state: {
    file: {} as Record<string, unknown> | undefined,
    transactions: [] as Array<{ id: string; data: Record<string, unknown> }>,
  },
}));

vi.mock("firebase-admin/firestore", async () => {
  const actual = await import("@google-cloud/firestore");
  const { state } = h;

  const snap = (id: string, data: Record<string, unknown> | undefined) => ({
    id,
    exists: data !== undefined,
    data: () => data,
  });

  const collection = (name: string) => {
    const q = {
      where: () => q,
      orderBy: () => q,
      limit: () => q,
      get: async () => {
        const docs =
          name === "transactions"
            ? state.transactions.map((t) => snap(t.id, t.data))
            : [];
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
      doc: (id: string) => ({
        id,
        get: async () => snap(id, name === "files" ? state.file : undefined),
      }),
    };
    return q;
  };

  return {
    getFirestore: () => ({ collection }),
    Timestamp: actual.Timestamp,
    FieldValue: actual.FieldValue,
  };
});

// Unwrap the callable so the handler can be invoked directly.
vi.mock("firebase-functions/v2/https", () => ({
  onCall: (_opts: unknown, handler: unknown) => handler,
  HttpsError: class extends Error {
    constructor(public code: string, message: string) {
      super(message);
    }
  },
}));

import { Timestamp } from "@google-cloud/firestore";
import { findTransactionMatchesForFile } from "../findTransactionMatches";

const USER = "u1";
const DATE = new Date("2026-07-01T00:00:00Z");

type Handler = (req: {
  auth: { uid: string };
  data: Record<string, unknown>;
}) => Promise<{ matches: Array<{ transactionId: string }>; totalCandidates: number }>;

const call = findTransactionMatchesForFile as unknown as Handler;

function seed(fileOver: Record<string, unknown> = {}) {
  h.state.file = {
    userId: USER,
    fileName: "hetzner.pdf",
    extractionComplete: true,
    extractedAmount: 11900,
    extractedCurrency: "EUR",
    extractedDate: Timestamp.fromDate(DATE),
    extractedPartner: "Hetzner Online GmbH",
    transactionIds: [],
    ...fileOver,
  };
  h.state.transactions = [
    {
      id: "t1",
      data: {
        userId: USER,
        date: Timestamp.fromDate(DATE),
        amount: -11900,
        currency: "EUR",
        name: "Hetzner Online GmbH",
        partner: "Hetzner Online GmbH",
        fileIds: [],
      },
    },
  ];
}

beforeEach(() => {
  seed();
});

describe("findTransactionMatchesForFile: dismissed pairs", () => {
  it("returns a strong pair the file has not dismissed", async () => {
    const result = await call({ auth: { uid: USER }, data: { fileId: "f1" } });

    expect(result.matches.map((m) => m.transactionId)).toEqual(["t1"]);
  });

  it("drops a pair the file dismissed", async () => {
    seed({ dismissedTransactionIds: ["t1"] });

    const result = await call({ auth: { uid: USER }, data: { fileId: "f1" } });

    expect(result.matches).toEqual([]);
    expect(result.totalCandidates).toBe(0);
  });

  it("still returns a dismissed pair for an explicit search", async () => {
    seed({ dismissedTransactionIds: ["t1"] });

    const result = await call({
      auth: { uid: USER },
      data: { fileId: "f1", searchQuery: "Hetzner" },
    });

    expect(result.matches.map((m) => m.transactionId)).toEqual(["t1"]);
  });
});
