/**
 * catchUpPartnerMatching: Transactions imported before a Global Partner
 * existed (or before it learned an alias) get matched once the directory
 * changes, without anyone opening them, and without repeated work or model
 * calls.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";
import { PRESET_PARTNERS } from "../../../lib/data/preset-partners";
import { catchUpPartnerMatchingCallable } from "../matching/catchUpPartnerMatching";
import { changesMatching } from "../matching/partnerCatalogVersion";

const db = getFirestore();
const U = "catchup-user";
const amazon = PRESET_PARTNERS.find((p) => p.name === "Amazon.com, Inc.")!;

const catchUp = () =>
  catchUpPartnerMatchingCallable.run({ data: null, auth: { uid: U, token: {} } } as never) as Promise<{
    skipped: boolean;
    version: number;
    processed?: number;
  }>;

async function suggestionsOf(id: string): Promise<Array<{ partnerId: string }>> {
  return ((await db.doc(`transactions/${id}`).get()).data()?.partnerSuggestions ?? []) as Array<{ partnerId: string }>;
}

beforeEach(async () => {
  await __whenShimIdle(); // the previous test's fire-and-forget writes, finished
  await __resetFirestoreShim();
  __resetTriggerShim();
  // Imported while the directory had no Amazon: no suggestion stored.
  await db.doc("transactions/amz").set({
    userId: U, name: "Amazon Mktpl*533bv1xm0", partner: "Amazon Mktpl*533bv1xm0",
    amount: -8206, currency: "EUR", date: Timestamp.now(), partnerId: null, fileIds: [],
  });
  await drainTriggers().catch(() => undefined);
  __resetTriggerShim();
});

describe("partner catalog version", () => {
  it("counts only changes the matcher reads", () => {
    expect(changesMatching({ name: "A", aliases: ["x"] }, { name: "A", aliases: ["x", "y"] })).toBe(true);
    expect(changesMatching({ name: "A", usageCount: 1 }, { name: "A", usageCount: 2 })).toBe(false);
    expect(changesMatching(undefined, { name: "A" })).toBe(true);
  });

  it("a Global Partner write that changes matching raises the version", async () => {
    await db.doc("globalPartners/amazon").set({ ...JSON.parse(JSON.stringify(amazon)), isActive: true });
    await drainTriggers();
    const v1 = (await db.doc("config/partnerCatalog").get()).data()?.version;
    await db.doc("globalPartners/amazon").update({ usageCount: 5 });
    await drainTriggers();
    expect((await db.doc("config/partnerCatalog").get()).data()?.version).toBe(v1);
    await db.doc("globalPartners/amazon").update({ aliases: [...(amazon.aliases ?? []), "Amzn Mktp"] });
    await drainTriggers();
    expect((await db.doc("config/partnerCatalog").get()).data()?.version).toBe(v1 + 1);
  });
});

describe("catchUpPartnerMatching", () => {
  it("matches a row the directory learned to match after its import, once", async () => {
    expect(await suggestionsOf("amz")).toEqual([]);
    await db.doc("globalPartners/amazon").set({ ...JSON.parse(JSON.stringify(amazon)), isActive: true });
    await drainTriggers();

    const first = await catchUp();
    expect(first.skipped).toBe(false);
    const after = await db.doc("transactions/amz").get();
    const matched = after.data()?.partnerId === "amazon" || (await suggestionsOf("amz")).some((s) => s.partnerId === "amazon");
    expect(matched).toBe(true);

    const second = await catchUp();
    expect(second.skipped).toBe(true);
  });

  it("runs again after a directory change or a change in the user's learned patterns", async () => {
    await catchUp();
    expect((await catchUp()).skipped).toBe(true);

    await db.doc("globalPartners/rewe").set({ name: "REWE", aliases: ["REWE"], isActive: true });
    await drainTriggers();
    expect((await catchUp()).skipped).toBe(false);
    expect((await catchUp()).skipped).toBe(true);

    await db.doc("partners/mine").set({ userId: U, name: "Mine", isActive: true, patternsUpdatedAt: Timestamp.now() });
    await drainTriggers().catch(() => undefined);
    expect((await catchUp()).skipped).toBe(false);
  });

  it("two tabs at once start one run", async () => {
    const [a, b] = await Promise.all([catchUp(), catchUp()]);
    expect([a.skipped, b.skipped].sort()).toEqual([false, true]);
  });

  it("never queues the agentic search", async () => {
    await db.doc("globalPartners/amazon").set({ ...JSON.parse(JSON.stringify(amazon)), isActive: true });
    await drainTriggers();
    await catchUp();
    const queued = await db.collection(`users/${U}/workerRequests`).get();
    expect(queued.size).toBe(0);
  });
});
