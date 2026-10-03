/**
 * findFileMatchesForTransaction (#555): which Files the Connect File window
 * opened from a Transaction ranks, and whose Transaction it will rank them
 * for. Scores themselves are held to the trigger's in scorer-parity.test.ts.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { findFileMatchesForTransactionCallable } from "../matching/findFileMatches";

const db = getFirestore();
const ME = "ffm-me";
const OTHER = "ffm-other";

const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));

type Match = { fileId: string; confidence: number };
function connectWindow(data: Record<string, unknown>, uid = ME) {
  return (
    findFileMatchesForTransactionCallable as unknown as {
      run: (req: unknown) => Promise<{ matches: Match[]; totalCandidates: number }>;
    }
  ).run({ data, auth: { uid, token: {} } });
}

function file(overrides: Record<string, unknown> = {}) {
  return {
    userId: ME,
    fileName: "invoice.pdf",
    extractionComplete: true,
    extractedAmount: 1990,
    extractedCurrency: "EUR",
    extractedDate: day("2026-03-10"),
    extractedPartner: "Hetzner Online GmbH",
    transactionIds: [],
    ...overrides,
  };
}

const ids = (r: { matches: Match[] }) => r.matches.map((m) => m.fileId).sort();

beforeEach(async () => {
  await __resetFirestoreShim();
  await db.collection("transactions").doc("t-mine").set({
    userId: ME,
    amount: -1990,
    currency: "EUR",
    date: day("2026-03-12"),
    name: "HETZNER ONLINE",
    fileIds: ["f-connected-here"],
  });
  await db.collection("transactions").doc("t-theirs").set({
    userId: OTHER,
    amount: -1990,
    currency: "EUR",
    date: day("2026-03-12"),
    name: "HETZNER ONLINE",
  });

  const files: Record<string, Record<string, unknown>> = {
    "f-in-window": file(),
    "f-undated": file({ extractedDate: null }),
    "f-undated-missing": (() => {
      const f = file();
      delete (f as Record<string, unknown>).extractedDate;
      return f;
    })(),
    "f-far": file({ extractedDate: day("2025-01-10"), fileName: "far-away.pdf" }),
    "f-connected-elsewhere": file({ transactionIds: ["t-other-line"] }),
    "f-connected-here": file({ transactionIds: ["t-mine"] }),
    "f-not-invoice": file({ isNotInvoice: true }),
    "f-deleted": file({ deletedAt: day("2026-03-20") }),
    "f-copy": file({ copyOfFileId: "f-in-window" }),
    "f-someone-elses": file({ userId: OTHER }),
  };
  for (const [id, data] of Object.entries(files)) {
    await db.collection("files").doc(id).set(data);
  }
});

describe("findFileMatchesForTransaction", () => {
  it("ranks dated-in-window, undated and split-payment Files, and nothing else", async () => {
    const result = await connectWindow({ transactionId: "t-mine" });
    expect(ids(result)).toEqual(
      ["f-connected-elsewhere", "f-in-window", "f-undated", "f-undated-missing"].sort()
    );
    expect(result.totalCandidates).toBe(4);
  });

  it("lets a search reach a File dated outside the window", async () => {
    const result = await connectWindow({ transactionId: "t-mine", searchQuery: "far-away" });
    expect(ids(result)).toEqual(["f-far"]);
  });

  it("never offers a not-an-invoice, deleted or Copy File, even to a search", async () => {
    const result = await connectWindow({ transactionId: "t-mine", searchQuery: "invoice" });
    expect(ids(result)).not.toContain("f-not-invoice");
    expect(ids(result)).not.toContain("f-deleted");
    expect(ids(result)).not.toContain("f-copy");
  });

  it("answers not-found for another user's Transaction", async () => {
    await expect(connectWindow({ transactionId: "t-theirs" })).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("answers not-found for a Transaction that does not exist", async () => {
    await expect(connectWindow({ transactionId: "t-nowhere" })).rejects.toMatchObject({
      code: "not-found",
    });
  });

  it("requires a Transaction id", async () => {
    await expect(connectWindow({})).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("cuts at the limit, best first", async () => {
    const result = await connectWindow({ transactionId: "t-mine", limit: 1 });
    expect(result.matches).toHaveLength(1);
    expect(result.totalCandidates).toBe(4);
  });
});
