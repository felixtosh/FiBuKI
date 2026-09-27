/**
 * #243: the connect overlay prints each Transaction's Remainder on its row, and
 * that figure has to be the one the scorer used. So the dialog callable hands
 * back the Coverage it scored each candidate with, rather than leaving the
 * overlay to work out a second sum from `fileIds`.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  state: {
    file: {} as Record<string, unknown> | undefined,
    transactions: [] as Array<{ id: string; data: Record<string, unknown> }>,
    connections: [] as Array<{ transactionId: string; fileId: string }>,
    files: {} as Record<string, Record<string, unknown>>,
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
        let docs: Array<ReturnType<typeof snap>> = [];
        if (name === "transactions") {
          docs = state.transactions.map((t) => snap(t.id, t.data));
        } else if (name === "fileConnections") {
          docs = state.connections.map((c, i) => snap(`c${i}`, { ...c }));
        } else if (name === "files") {
          docs = Object.entries(state.files).map(([id, data]) => snap(id, data));
        }
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

interface Coverage {
  documentedAmount: number;
  remainder: number;
  isCovered: boolean;
  againstRemainder: boolean;
}

type Handler = (req: {
  auth: { uid: string };
  data: Record<string, unknown>;
}) => Promise<{
  matches: Array<{ transactionId: string; coverage?: Coverage }>;
  totalCandidates: number;
}>;

const call = findTransactionMatchesForFile as unknown as Handler;

function seed(opts: { documented?: number } = {}) {
  h.state.file = {
    userId: USER,
    fileName: "part-2.pdf",
    extractionComplete: true,
    extractedAmount: 4000,
    extractedCurrency: "EUR",
    extractedDate: Timestamp.fromDate(DATE),
    extractedPartner: "Hetzner Online GmbH",
    transactionIds: [],
  };
  h.state.transactions = [
    {
      id: "t1",
      data: {
        userId: USER,
        date: Timestamp.fromDate(DATE),
        amount: -10000,
        currency: "EUR",
        name: "Hetzner Online GmbH",
        partner: "Hetzner Online GmbH",
        fileIds: opts.documented != null ? ["f-other"] : [],
      },
    },
  ];
  h.state.connections =
    opts.documented != null ? [{ transactionId: "t1", fileId: "f-other" }] : [];
  h.state.files =
    opts.documented != null
      ? { "f-other": { userId: USER, extractedAmount: opts.documented } }
      : {};
}

beforeEach(() => seed());

describe("findTransactionMatchesForFile: Coverage on each match", () => {
  it("returns the Remainder the pair was scored against for a partly documented Transaction", async () => {
    seed({ documented: 6000 });
    const result = await call({ auth: { uid: USER }, data: { fileId: "f1" } });
    const t1 = result.matches.find((m) => m.transactionId === "t1");
    expect(t1?.coverage).toEqual({
      documentedAmount: 6000,
      remainder: 4000,
      isCovered: false,
      againstRemainder: true,
    });
  });

  it("marks a fully documented Transaction as covered", async () => {
    seed({ documented: 10000 });
    const result = await call({ auth: { uid: USER }, data: { fileId: "f1" } });
    const t1 = result.matches.find((m) => m.transactionId === "t1");
    expect(t1?.coverage?.isCovered).toBe(true);
    expect(t1?.coverage?.againstRemainder).toBe(false);
  });

  it("carries no Coverage for a Transaction holding no Files", async () => {
    const result = await call({ auth: { uid: USER }, data: { fileId: "f1" } });
    const t1 = result.matches.find((m) => m.transactionId === "t1");
    expect(t1).toBeDefined();
    expect(t1?.coverage).toBeUndefined();
  });
});
