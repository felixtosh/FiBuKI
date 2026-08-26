/**
 * Fork #94, second enforcement path: the partner-side sweep.
 *
 * matchFilesForPartnerInternal scores every unconnected file against every
 * unfiled transaction of a partner and auto-connects at 85%. It read no
 * dismissal state, so a pair the user rejected was reconnected the next time a
 * partner assignment or a learned pattern kicked the sweep off — the same
 * user-visible bug as the re-score path, through a different door.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  state: {
    partner: {} as Record<string, unknown>,
    transactions: [] as Array<{ id: string; data: Record<string, unknown> }>,
    files: [] as Array<{ id: string; data: Record<string, unknown> }>,
    connections: [] as Record<string, unknown>[],
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

  const results = (name: string) => {
    if (name === "transactions") return state.transactions;
    if (name === "files") return state.files;
    return [];
  };

  const collection = (name: string) => {
    const q = {
      where: () => q,
      orderBy: () => q,
      limit: () => q,
      get: async () => {
        const docs = results(name).map((d) => snap(d.id, d.data));
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
      doc: (id: string) => ({
        id,
        get: async () =>
          snap(id, name === "partners" ? state.partner : undefined),
        set: async () => undefined,
        update: async () => undefined,
      }),
    };
    return q;
  };

  return {
    getFirestore: () => ({
      collection,
      batch: () => ({
        set: (_ref: unknown, data: Record<string, unknown>) => {
          if (data.connectionType) state.connections.push(data);
        },
        update: () => undefined,
        commit: async () => undefined,
      }),
    }),
    Timestamp: actual.Timestamp,
    FieldValue: actual.FieldValue,
  };
});

vi.mock("firebase-functions/v2/https", () => ({
  onCall: () => ({}),
  HttpsError: class extends Error {},
}));

import { Timestamp } from "@google-cloud/firestore";
import { matchFilesForPartnerInternal } from "../matchFilesForPartner";

const USER = "u1";
const PARTNER = "p1";
const DATE = new Date("2026-07-01T00:00:00Z");

function seed(fileOver: Record<string, unknown> = {}) {
  h.state.partner = { userId: USER, name: "Hetzner Online GmbH", fileSourcePatterns: [] };
  h.state.transactions = [
    {
      id: "t1",
      data: {
        userId: USER,
        partnerId: PARTNER,
        date: Timestamp.fromDate(DATE),
        amount: -11900,
        currency: "EUR",
        name: "Hetzner Online GmbH",
        partner: "Hetzner Online GmbH",
        fileIds: [],
      },
    },
  ];
  h.state.files = [
    {
      id: "f1",
      data: {
        userId: USER,
        partnerId: PARTNER,
        fileName: "hetzner.pdf",
        extractionComplete: true,
        extractedAmount: 11900,
        extractedCurrency: "EUR",
        extractedDate: Timestamp.fromDate(DATE),
        extractedPartner: "Hetzner Online GmbH",
        transactionIds: [],
        ...fileOver,
      },
    },
  ];
}

beforeEach(() => {
  h.state.connections = [];
});

describe("matchFilesForPartnerInternal: dismissed pairs", () => {
  it("auto-connects a strong pair the file has not dismissed", async () => {
    seed();

    const result = await matchFilesForPartnerInternal(USER, PARTNER);

    expect(result.autoMatched).toBe(1);
    expect(h.state.connections).toHaveLength(1);
    expect(h.state.connections[0].transactionId).toBe("t1");
  });

  it("does not auto-connect a pair the file dismissed", async () => {
    seed({ dismissedTransactionIds: ["t1"] });

    const result = await matchFilesForPartnerInternal(USER, PARTNER);

    expect(result.autoMatched).toBe(0);
    expect(result.suggested).toBe(0);
    expect(h.state.connections).toEqual([]);
  });

  it("honours the object form of the dismissal record", async () => {
    seed({
      dismissedTransactions: [
        { transactionId: "t1", dismissedAt: Timestamp.fromDate(DATE), confidence: 92 },
      ],
    });

    const result = await matchFilesForPartnerInternal(USER, PARTNER);

    expect(result.autoMatched).toBe(0);
    expect(h.state.connections).toEqual([]);
  });
});
