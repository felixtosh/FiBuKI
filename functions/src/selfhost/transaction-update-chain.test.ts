/**
 * Hardening test — onTransactionUpdate chain on the selfhost shim.
 *
 * The busiest trigger in the app (transactions/{id} onUpdate), imported
 * UNMODIFIED, covering its four independent jobs:
 *
 *   1. isComplete sync (self-retriggering write, must converge)
 *   2. partner resolution learning (dynamic import of learnPartnerResolution,
 *      fires on the isComplete:false→true edge)
 *   3. category matching on partner assignment (legacy matchedPartnerIds and
 *      partnerCategoryRules paths, auto-apply vs suggestions-only,
 *      arrayUnion side-writes onto the category doc)
 *   4. fire-and-forget side automations: receipt-search queueing (active
 *      mode) and card reconciliation (source partners) — unawaited promise
 *      chains inside the handler, observed via polling
 *
 * Exercises shim surfaces the Gate 3 spike didn't: subcollection paths via
 * slash-string collection ids (`users/{uid}/workerRequests`), Timestamp
 * range filters + orderBy desc + limit, batch() with mixed set/update,
 * arrayUnion of objects containing Timestamps, and trigger cascades three
 * writes deep (partner assign → auto-category → resolution learning).
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";
import { waitFor } from "./test-helpers";

// REAL trigger module, unmodified:
import "../matching/onTransactionUpdate";

const db = getFirestore();
const USER = "stefan-test";

async function seedSubscription(mode: "active" | "passive") {
  await db.collection("subscriptions").doc(USER).set({
    userId: USER,
    automationMode: mode,
    planId: "free",
  });
}

function baseTx(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER,
    sourceId: "src-bank",
    date: Timestamp.fromDate(new Date("2026-07-01")),
    amount: -1999,
    currency: "EUR",
    name: "Some Vendor",
    reference: null,
    fileIds: [],
    isComplete: false,
    partnerId: null,
    partnerType: null,
    noReceiptCategoryId: null,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    ...overrides,
  };
}

async function seedCategory(id: string, overrides: Record<string, unknown> = {}) {
  await db.collection("noReceiptCategories").doc(id).set({
    userId: USER,
    templateId: "private-personal",
    name: "Private",
    matchedPartnerIds: [],
    learnedPatterns: [],
    manualRemovals: [],
    transactionCount: 0,
    isActive: true,
    ...overrides,
  });
}

beforeEach(async () => {
  await __resetFirestoreShim();
  __resetTriggerShim();
  await seedSubscription("passive");
});

describe("selfhost hardening: onTransactionUpdate chain", () => {
  // -------------------------------------------------------------------------
  // 1. isComplete sync
  // -------------------------------------------------------------------------

  it("syncs isComplete=true when a file is attached (self-retriggering write converges)", async () => {
    await db.collection("transactions").doc("t1").set(baseTx());

    await db.collection("transactions").doc("t1").update({
      fileIds: ["f-1"],
      updatedAt: Timestamp.now(),
    });
    await drainTriggers();

    const tx = (await db.collection("transactions").doc("t1").get()).data()!;
    expect(tx.isComplete).toBe(true);
  });

  it("syncs isComplete back to false when the last file is detached", async () => {
    await db.collection("transactions").doc("t1").set(baseTx({ fileIds: ["f-1"], isComplete: true }));

    await db.collection("transactions").doc("t1").update({
      fileIds: [],
      updatedAt: Timestamp.now(),
    });
    await drainTriggers();

    const tx = (await db.collection("transactions").doc("t1").get()).data()!;
    expect(tx.isComplete).toBe(false);
  });

  // -------------------------------------------------------------------------
  // 2. Resolution learning (dynamic import inside the trigger)
  // -------------------------------------------------------------------------

  it("learns the partner's resolution preference across completions", async () => {
    await db.collection("partners").doc("p-rewe").set({
      userId: USER,
      name: "REWE",
      isActive: true,
    });
    await seedCategory("cat-private", { templateId: "private-personal" });

    // Three transactions, all resolved no-receipt. Each category assignment
    // first triggers the isComplete sync write, whose own trigger event
    // carries the false→true edge that feeds the learner.
    for (let i = 1; i <= 3; i++) {
      const id = `t-learn-${i}`;
      await db.collection("transactions").doc(id).set(
        baseTx({ partnerId: "p-rewe", partnerType: "user", name: `REWE ${i}` }),
      );
      await db.collection("transactions").doc(id).update({
        noReceiptCategoryId: "cat-private",
        updatedAt: Timestamp.now(),
      });
      await drainTriggers();
    }

    const partner = (await db.collection("partners").doc("p-rewe").get()).data()!;
    const pref = partner.resolutionPreference as {
      type: string;
      confidence: number;
      preferredNoReceiptCategoryId: string | null;
      preferredNoReceiptCategoryTemplateId: string | null;
      stats: { fileCount: number; noReceiptCount: number };
    };
    expect(pref.stats.noReceiptCount).toBe(3);
    expect(pref.stats.fileCount).toBe(0);
    expect(pref.type).toBe("no_receipt"); // MIN_SAMPLE_SIZE=3 reached
    expect(pref.confidence).toBeGreaterThanOrEqual(60);
    expect(pref.preferredNoReceiptCategoryId).toBe("cat-private");
    // Template id back-filled by the category lookup inside the learner
    expect(pref.preferredNoReceiptCategoryTemplateId).toBe("private-personal");
  });

  // -------------------------------------------------------------------------
  // 3. Category matching on partner assignment
  // -------------------------------------------------------------------------

  it("auto-applies a legacy matchedPartnerIds category and cascades into learning", async () => {
    await db.collection("partners").doc("p-hetzner").set({
      userId: USER,
      name: "Hetzner",
      isActive: true,
    });
    await seedCategory("cat-hosting", {
      templateId: "bank-fees",
      matchedPartnerIds: ["p-hetzner"],
    });
    await db.collection("transactions").doc("t-cat").set(baseTx({ name: "Hetzner Online" }));

    await db.collection("transactions").doc("t-cat").update({
      partnerId: "p-hetzner",
      partnerType: "user",
      partnerMatchedBy: "manual",
      updatedAt: Timestamp.now(),
    });
    await drainTriggers();

    const tx = (await db.collection("transactions").doc("t-cat").get()).data()!;
    expect(tx.noReceiptCategoryId).toBe("cat-hosting");
    expect(tx.noReceiptCategoryMatchedBy).toBe("auto");
    expect(tx.noReceiptCategoryConfidence).toBeGreaterThanOrEqual(89);
    expect(tx.isComplete).toBe(true);
    const suggestions = tx.categorySuggestions as Array<{ categoryId: string }>;
    expect(suggestions[0].categoryId).toBe("cat-hosting");
    const history = tx.automationHistory as Array<{ type: string }>;
    expect(history.some((h) => h.type === "category_matched")).toBe(true);

    // Third-order cascade: the auto-apply write completed the transaction,
    // which must feed resolution learning on the SAME partner.
    const partner = (await db.collection("partners").doc("p-hetzner").get()).data()!;
    const pref = partner.resolutionPreference as { stats: { noReceiptCount: number } };
    expect(pref.stats.noReceiptCount).toBe(1);
  });

  it("auto-applies via partnerCategoryRules and arrayUnions the partner onto the category", async () => {
    await db.collection("partners").doc("p-google").set({
      userId: USER,
      name: "Google Ireland",
      isActive: true,
      categoryMatchRules: [
        { categoryId: "cat-private", patterns: ["*youtube*"], confidence: 92 },
      ],
    });
    await seedCategory("cat-private", { matchedPartnerIds: [] });
    await db
      .collection("transactions")
      .doc("t-rule")
      .set(baseTx({ name: "YOUTUBEPREMIUM Abo" }));

    await db.collection("transactions").doc("t-rule").update({
      partnerId: "p-google",
      partnerType: "user",
      partnerMatchedBy: "manual",
      updatedAt: Timestamp.now(),
    });
    await drainTriggers();

    const tx = (await db.collection("transactions").doc("t-rule").get()).data()!;
    expect(tx.noReceiptCategoryId).toBe("cat-private");
    const suggestions = tx.categorySuggestions as Array<{ source: string }>;
    expect(suggestions[0].source).toBe("partner_rule");

    // Side-write: partner linked onto the category via FieldValue.arrayUnion
    const cat = (await db.collection("noReceiptCategories").doc("cat-private").get()).data()!;
    expect(cat.matchedPartnerIds).toContain("p-google");
  });

  it("stores suggestions without auto-applying when rule confidence is below threshold", async () => {
    await db.collection("partners").doc("p-google").set({
      userId: USER,
      name: "Google Ireland",
      isActive: true,
      categoryMatchRules: [
        { categoryId: "cat-private", patterns: ["*youtube*"], confidence: 70 },
      ],
    });
    await seedCategory("cat-private");
    await db
      .collection("transactions")
      .doc("t-suggest")
      .set(baseTx({ name: "YOUTUBEPREMIUM Abo" }));

    await db.collection("transactions").doc("t-suggest").update({
      partnerId: "p-google",
      partnerType: "user",
      partnerMatchedBy: "manual",
      updatedAt: Timestamp.now(),
    });
    await drainTriggers();

    const tx = (await db.collection("transactions").doc("t-suggest").get()).data()!;
    expect(tx.noReceiptCategoryId ?? null).toBeNull();
    expect(tx.isComplete).toBe(false);
    const suggestions = tx.categorySuggestions as Array<{ confidence: number }>;
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions[0].confidence).toBeLessThan(89);
  });

  it("skips all partner automations for auto-matched transactions", async () => {
    await db.collection("partners").doc("p-hetzner").set({
      userId: USER,
      name: "Hetzner",
      isActive: true,
    });
    await seedCategory("cat-hosting", { matchedPartnerIds: ["p-hetzner"] });
    await db.collection("transactions").doc("t-auto").set(baseTx());

    await db.collection("transactions").doc("t-auto").update({
      partnerId: "p-hetzner",
      partnerType: "user",
      partnerMatchedBy: "auto", // bulk pattern-learning path, must not fan out
      updatedAt: Timestamp.now(),
    });
    await drainTriggers();

    const tx = (await db.collection("transactions").doc("t-auto").get()).data()!;
    expect(tx.noReceiptCategoryId ?? null).toBeNull();
    expect(tx.categorySuggestions ?? null).toBeNull();
  });

  // -------------------------------------------------------------------------
  // 4. Fire-and-forget side automations
  // -------------------------------------------------------------------------

  it("queues a receipt-search workerRequest in active mode (fire-and-forget, subcollection path)", async () => {
    await seedSubscription("active");
    await db.collection("partners").doc("p-vendor").set({
      userId: USER,
      name: "Some Vendor",
      isActive: true,
    });
    // A running worker forces the deterministic queue-as-document fallback
    // (no external worker API call attempted).
    await db.collection(`users/${USER}/workerRuns`).doc("run-busy").set({
      userId: USER,
      status: "running",
      createdAt: Timestamp.now(),
    });
    await db.collection("transactions").doc("t-search").set(baseTx());

    await db.collection("transactions").doc("t-search").update({
      partnerId: "p-vendor",
      partnerType: "user",
      partnerMatchedBy: "manual",
      updatedAt: Timestamp.now(),
    });

    await waitFor(async () => {
      const reqs = await db.collection(`users/${USER}/workerRequests`).get();
      return !reqs.empty;
    });

    const reqs = await db.collection(`users/${USER}/workerRequests`).get();
    const req = reqs.docs[0].data()!;
    expect(req.workerType).toBe("receipt_search");
    expect(req.status).toBe("pending");
    expect((req.triggerContext as { transactionId: string }).transactionId).toBe("t-search");

    // The queue write also stamps the transaction's automationHistory.
    await waitFor(async () => {
      const tx = (await db.collection("transactions").doc("t-search").get()).data()!;
      const history = (tx.automationHistory as Array<{ type: string }>) || [];
      return history.some((h) => h.type === "receipt_search");
    });
  });

  it("reconciles a card-settlement bank transaction when a source partner is assigned", async () => {
    await db.collection("sources").doc("src-bank").set({
      userId: USER,
      name: "Bank",
      type: "manual",
      isActive: true,
    });
    await db.collection("sources").doc("src-card").set({
      userId: USER,
      name: "Amex",
      type: "manual",
      isActive: true,
      linkedSourceId: "src-bank",
    });
    await db.collection("partners").doc("p-amex").set({
      userId: USER,
      name: "American Express",
      isActive: true,
      identitySourceField: "source:src-card",
    });

    // Two unreconciled card charges summing exactly to the bank payment.
    await db.collection("transactions").doc("t-charge-1").set(
      baseTx({
        sourceId: "src-card",
        amount: -3000,
        name: "Charge A",
        date: Timestamp.fromDate(new Date("2026-06-20")),
      }),
    );
    await db.collection("transactions").doc("t-charge-2").set(
      baseTx({
        sourceId: "src-card",
        amount: -2000,
        name: "Charge B",
        date: Timestamp.fromDate(new Date("2026-06-25")),
      }),
    );
    await db.collection("transactions").doc("t-settle").set(
      baseTx({
        sourceId: "src-bank",
        amount: -5000,
        name: "AMEX SETTLEMENT",
        date: Timestamp.fromDate(new Date("2026-07-01")),
      }),
    );
    await drainTriggers(); // flush seed-write events before the real update

    await db.collection("transactions").doc("t-settle").update({
      partnerId: "p-amex",
      partnerType: "user",
      partnerMatchedBy: "manual",
      updatedAt: Timestamp.now(),
    });

    // Reconciliation is an unawaited dynamic-import chain inside the trigger.
    await waitFor(async () => {
      const groups = await db.collection("cardReconciliationGroups").get();
      return !groups.empty;
    });

    const groups = await db.collection("cardReconciliationGroups").get();
    const group = groups.docs[0].data()!;
    expect(group.bankTransactionId).toBe("t-settle");
    expect(group.cardSourceId).toBe("src-card");
    expect((group.cardTransactionIds as string[]).sort()).toEqual(["t-charge-1", "t-charge-2"]);
    expect(group.cardChargesSum).toBe(5000);
    // Exact sum + in-window dates + linked source + source partner ⇒ auto-confirm
    expect(group.status).toBe("confirmed");

    await waitFor(async () => {
      const tx = (await db.collection("transactions").doc("t-settle").get()).data()!;
      return tx.reconciliationMatchComplete === true;
    });
    const charge = (await db.collection("transactions").doc("t-charge-1").get()).data()!;
    expect(charge.reconciledByBankTxId).toBe("t-settle");
  });
});
