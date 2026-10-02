/**
 * scoreFileTransactionMatch: the by-id scorer the chat agent's
 * scoreBatchMatches tool calls. Before it existed the tool sent ids to
 * scoreAttachmentMatch, which takes objects, so every pair scored 0.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";
import { scoreFileTransactionMatchCallable } from "../matching/scoreFileTransactionMatchCallable";

const db = getFirestore();
const ME = "scorer-me";
const OTHER = "scorer-other";

function call(data: unknown, uid = ME) {
  return scoreFileTransactionMatchCallable.run({ data, auth: { uid, token: {} } } as never);
}

beforeEach(async () => {
  await __resetFirestoreShim();
  __resetTriggerShim();
  const date = Timestamp.fromDate(new Date("2026-09-10T10:00:00Z"));
  await db.doc("transactions/tx1").set({ userId: ME, amount: -4990, currency: "EUR", date, name: "Hetzner Online GmbH", partner: "Hetzner Online GmbH", fileIds: [] });
  await db.doc("files/f1").set({ userId: ME, extractedAmount: 4990, extractedCurrency: "EUR", extractedDate: date, extractedPartner: "Hetzner Online GmbH", extractionComplete: true, transactionIds: [], fileName: "hetzner.pdf" });
  await db.doc("files/foreign").set({ userId: OTHER, extractedAmount: 4990, extractedCurrency: "EUR", extractedDate: date, extractionComplete: true, transactionIds: [] });
});

describe("scoreFileTransactionMatch", () => {
  it("scores an owned pair with the shared scorer", async () => {
    const r = (await call({ fileId: "f1", transactionId: "tx1" })) as { confidence: number };
    expect(typeof r.confidence).toBe("number");
    // Same amount, same day, same partner name: a real score, not the 0 the
    // broken tool produced for everything.
    expect(r.confidence).toBeGreaterThan(50);
  });

  it("answers a foreign id exactly like a missing one", async () => {
    const foreign = await call({ fileId: "foreign", transactionId: "tx1" }).catch((e) => e);
    const missing = await call({ fileId: "no-such-file", transactionId: "tx1" }).catch((e) => e);
    expect(foreign.code).toBe("not-found");
    expect(missing.code).toBe("not-found");
    expect(foreign.message).toBe(missing.message);
  });

  it("refuses a malformed request", async () => {
    const e = await call({ fileId: ["f1"], transactionId: "tx1" }).catch((x) => x);
    expect(e.code).toBe("invalid-argument");
  });
});
