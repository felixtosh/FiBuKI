/**
 * A Transaction deleted with its bank account or import is no File's
 * suggestion any more (fibuki.com, 2026-10-12: the chat acted on an 88%
 * suggestion of a deleted Transaction and got "Transaction not found").
 *
 * - detachTransactions prunes the suggestions with the connections, and logs
 *   the File's new best suggestion (#752);
 * - list_files and get_file leave out a suggestion whose Transaction is gone,
 *   for Files that were left stale before the pruning existed.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { detachTransactions } from "../fileConnections/writer";
import { handleTool } from "../tools/handlers";

const db = getFirestore();
const ME = "stale-me";
const OTHER = "stale-other";
const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));

const suggestion = (transactionId: string, confidence: number, name: string) => ({
  transactionId,
  confidence,
  matchSources: ["amount_exact"],
  preview: { name, amount: -1000, date: "2026-01-01" },
});

beforeEach(async () => {
  await __resetFirestoreShim();
  const tx = (id: string, userId = ME) =>
    db.collection("transactions").doc(id).set({ userId, sourceId: "s", amount: -1000, currency: "EUR", date: day("2026-01-01"), name: id, fileIds: [] });
  await tx("t-live");
  await tx("t-theirs", OTHER);
  await db.collection("files").doc("f-1").set({
    userId: ME,
    fileName: "spusu.pdf",
    extractionComplete: true,
    transactionIds: [],
    transactionSuggestions: [
      suggestion("t-gone", 88, "KdNr: 4421720"),
      suggestion("t-live", 70, "t-live"),
      suggestion("t-theirs", 60, "t-theirs"),
    ],
  });
});

describe("the tools answer only suggestions of the User's existing Transactions", () => {
  it("get_file", async () => {
    const file = (await handleTool(ME, "get_file", { fileId: "f-1" })) as { transactionSuggestions: Array<{ transactionId: string }> };
    expect(file.transactionSuggestions.map((s) => s.transactionId)).toEqual(["t-live"]);
  });

  it("list_files", async () => {
    const page = (await handleTool(ME, "list_files", {})) as { files: Array<{ id: string; transactionSuggestions: Array<{ transactionId: string }> }> };
    expect(page.files.find((f) => f.id === "f-1")?.transactionSuggestions.map((s) => s.transactionId)).toEqual(["t-live"]);
  });
});

describe("deleting Transactions with their bank account prunes their suggestions", () => {
  it("removes the suggestion and logs the new best one", async () => {
    await db.collection("transactions").doc("t-gone").set({ userId: ME, sourceId: "s", amount: -1000, date: day("2026-01-01"), name: "KdNr: 4421720", fileIds: [] });
    const gone = await db.collection("transactions").doc("t-gone").get();
    await detachTransactions(db as never, ME, [{ id: gone.id, data: gone.data()! }]);

    const file = (await db.collection("files").doc("f-1").get()).data()!;
    expect(file.transactionSuggestions.map((s: { transactionId: string }) => s.transactionId)).toEqual(["t-live", "t-theirs"]);
    const logged = (file.automationHistory ?? []).find((e: { type: string }) => e.type === "transaction_suggested");
    expect(logged?.transactionId).toBe("t-live");
  });
});
