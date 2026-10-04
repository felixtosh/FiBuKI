/**
 * The connect dialog's search by amount (#183): a typed amount, in any of the
 * ways a person writes one, reaches the Transaction that carries it. Which
 * pairs a search may show is the matcher's (selfhost/matcher.test.ts).
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

describe("findTransactionMatchesForFile: search by amount (#183)", () => {
  beforeEach(() => {
    seed({ extractedAmount: 21420, extractedPartner: null });
    h.state.transactions = [
      {
        id: "paid",
        data: { userId: USER, date: Timestamp.fromDate(DATE), amount: -21420, currency: "EUR", name: "Card payment", fileIds: [] },
      },
      {
        id: "other",
        data: { userId: USER, date: Timestamp.fromDate(DATE), amount: -956, currency: "EUR", name: "Coffee", fileIds: [] },
      },
    ];
  });

  it.each(["214,20", "214.20", "€ 214,20", "21420", "214"])(
    "%s passes the candidate gate for the -214,20 transaction only",
    async (searchQuery) => {
      const result = await call({ auth: { uid: USER }, data: { fileId: "f1", searchQuery } });
      expect(result.matches.map((m) => m.transactionId)).toEqual(["paid"]);
    }
  );

  it("a non-numeric query still filters by text", async () => {
    const result = await call({ auth: { uid: USER }, data: { fileId: "f1", searchQuery: "coffee" } });
    expect(result.matches.map((m) => m.transactionId)).toEqual(["other"]);
  });
});
