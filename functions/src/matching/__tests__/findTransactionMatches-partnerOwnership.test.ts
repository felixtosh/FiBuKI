/**
 * #411: the connect dialog takes a caller-supplied `partnerId` on the raw
 * `fileInfo` path. A Partner another User owns must not reach the scorer:
 * none of its aliases, billing-cycle bands or learned weights, and no read of
 * the Global Partner it links to.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  state: {
    transactions: [] as Array<{ id: string; data: Record<string, unknown> }>,
    partners: {} as Record<string, Record<string, unknown>>,
    globalPartners: {} as Record<string, Record<string, unknown>>,
    docReads: [] as string[],
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
          name === "transactions" ? state.transactions.map((t) => snap(t.id, t.data)) : [];
        return { docs, size: docs.length, empty: docs.length === 0 };
      },
      doc: (id: string) => ({
        id,
        get: async () => {
          state.docReads.push(`${name}/${id}`);
          const store =
            name === "partners"
              ? state.partners
              : name === "globalPartners"
                ? state.globalPartners
                : {};
          return snap(id, store[id]);
        },
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

const CALLER = "u1";
const OTHER_TENANT = "u2";
const DATE = new Date("2026-07-01T00:00:00Z");

type Handler = (req: {
  auth: { uid: string };
  data: Record<string, unknown>;
}) => Promise<{
  matches: Array<{
    transactionId: string;
    confidence: number;
    breakdown: Record<string, unknown> & { partner: number };
  }>;
}>;

const call = findTransactionMatchesForFile as unknown as Handler;

/** A Partner whose only tie to the Transaction is its alias. */
function partnerOwnedBy(userId: string) {
  return {
    userId,
    name: "Zyxwv Holding",
    aliases: ["QRSTU PAYMENTS"],
    globalPartnerId: "g1",
    scoringWeights: { amountWeight: 0.1, dateWeight: 0.1, partnerWeight: 0.8 },
  };
}

beforeEach(() => {
  h.state.docReads = [];
  h.state.transactions = [
    {
      id: "t1",
      data: {
        userId: CALLER,
        date: Timestamp.fromDate(DATE),
        amount: -4200,
        currency: "EUR",
        name: "QRSTU PAYMENTS",
        partner: "QRSTU PAYMENTS",
      },
    },
  ];
  h.state.partners = {
    "p-own": partnerOwnedBy(CALLER),
    "p-foreign": partnerOwnedBy(OTHER_TENANT),
  };
  h.state.globalPartners = { g1: { name: "Zyxwv Global", aliases: [] } };
});

async function scoreOf(partnerId: string | null) {
  const result = await call({
    auth: { uid: CALLER },
    data: {
      fileInfo: {
        extractedAmount: 4200,
        extractedCurrency: "EUR",
        extractedDate: DATE.toISOString(),
        extractedPartner: "Unrelated Name",
        partnerId,
      },
    },
  });
  return result.matches.find((m) => m.transactionId === "t1")!;
}

describe("findTransactionMatchesForFile: partnerId ownership (#411)", () => {
  it("applies the caller's own Partner (control)", async () => {
    const none = await scoreOf(null);
    const own = await scoreOf("p-own");
    expect(own.breakdown.partner).toBeGreaterThan(none.breakdown.partner);
  });

  it("scores a second tenant's Partner as no Partner at all", async () => {
    const none = await scoreOf(null);
    const foreign = await scoreOf("p-foreign");
    expect(foreign.confidence).toBe(none.confidence);
    expect(foreign.breakdown).toEqual(none.breakdown);
  });

  it("reads nothing the foreign Partner links to", async () => {
    await scoreOf("p-foreign");
    expect(h.state.docReads).toContain("partners/p-foreign");
    expect(h.state.docReads).not.toContain("globalPartners/g1");
  });
});
