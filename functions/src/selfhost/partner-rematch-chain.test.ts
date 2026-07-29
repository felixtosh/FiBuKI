/**
 * Hardening test — partner re-matching chains on the selfhost shim.
 *
 * Three real trigger modules imported UNMODIFIED, registered side by side
 * (like the production process will register all of them):
 *
 *   onPartnerCreate  (partners onCreate)  — re-matches unmatched transactions
 *     against the new partner AND the globalPartners pool, localizes global
 *     partners (which creates a partner doc → the create-trigger fires again
 *     and must self-skip), then chains matchCategoriesForTransactions.
 *   onPartnerUpdate  (partners onUpdate)  — re-evaluates auto-matched and
 *     unmatched FILES on identity-field change, and re-matches orphaned
 *     files on soft-delete (isActive true→false).
 *   onTransactionUpdate (transactions onUpdate) — receives the writes the
 *     other two make; auto-assigned transactions must NOT fan out.
 *
 * Loop prevention is the point: partner create → tx auto-assign →
 * onTransactionUpdate skip (matchedBy=auto), and global-partner
 * localization → partners create → onPartnerCreate guard skip.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";

// REAL trigger modules, unmodified:
import "../matching/onPartnerCreate";
import "../matching/onPartnerUpdate";
import "../matching/onTransactionUpdate";

const db = getFirestore();
const USER = "stefan-test";
const IBAN_A = "AT611904300234573201";
const IBAN_B = "DE89370400440532013000";
const IBAN_GLOBAL = "NL91ABNA0417164300";

function baseTx(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER,
    sourceId: "src-bank",
    date: Timestamp.fromDate(new Date("2026-07-01")),
    amount: -1500,
    currency: "EUR",
    name: "Some Vendor",
    partner: null,
    partnerIban: null,
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

function baseFile(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER,
    fileName: "doc.pdf",
    fileType: "application/pdf",
    extractionComplete: true,
    partnerMatchComplete: true,
    transactionIds: [],
    extractedPartner: null,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    ...overrides,
  };
}

beforeEach(async () => {
  await __resetFirestoreShim();
  __resetTriggerShim();
  await db.collection("subscriptions").doc(USER).set({
    userId: USER,
    automationMode: "passive",
    planId: "free",
  });
  await drainTriggers();
});

describe("selfhost hardening: onPartnerCreate re-match chain", () => {
  it("auto-assigns unmatched transactions by IBAN and chains category matching", async () => {
    await db.collection("transactions").doc("t-open").set(
      baseTx({ name: "HETZNER FN123", partnerIban: IBAN_A }),
    );
    await db.collection("transactions").doc("t-removed").set(
      baseTx({ name: "HETZNER FN456", partnerIban: IBAN_A }),
    );
    await db.collection("noReceiptCategories").doc("cat-hosting").set({
      userId: USER,
      templateId: "bank-fees",
      name: "Hosting",
      matchedPartnerIds: ["p-new"],
      learnedPatterns: [],
      manualRemovals: [],
      transactionCount: 0,
      isActive: true,
    });
    await drainTriggers(); // flush seed events before the create under test

    await db.collection("partners").doc("p-new").set({
      userId: USER,
      name: "Hetzner Online GmbH",
      aliases: [],
      ibans: [IBAN_A],
      isActive: true,
      manualRemovals: [{ transactionId: "t-removed" }],
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
    await drainTriggers();

    const tx = (await db.collection("transactions").doc("t-open").get()).data()!;
    expect(tx.partnerId).toBe("p-new");
    expect(tx.partnerType).toBe("user");
    expect(tx.partnerMatchedBy).toBe("auto");
    expect(tx.partnerMatchConfidence).toBe(100); // IBAN match is definitive
    const history = tx.automationHistory as Array<{ type: string }>;
    expect(history.some((h) => h.type === "partner_assigned")).toBe(true);

    // Chained matchCategoriesForTransactions assigned the linked category,
    // and the resulting transaction update completed the doc.
    expect(tx.noReceiptCategoryId).toBe("cat-hosting");
    expect(tx.isComplete).toBe(true);

    // Manual removal respected: same IBAN, but the user detached this tx
    // from the partner before — it must stay unmatched.
    const removed = (await db.collection("transactions").doc("t-removed").get()).data()!;
    expect(removed.partnerId ?? null).toBeNull();
    expect(removed.partnerSuggestions ?? null).toBeNull();
  });

  it("localizes a matching global partner and the localized create self-skips", async () => {
    await db.collection("globalPartners").doc("g-netflix").set({
      name: "Netflix International B.V.",
      aliases: ["Netflix"],
      ibans: [IBAN_GLOBAL],
      isActive: true,
    });
    await db.collection("transactions").doc("t-flix").set(
      baseTx({ name: "NETFLIX.COM", partnerIban: IBAN_GLOBAL }),
    );
    await drainTriggers();

    // Creating an UNRELATED partner triggers the re-match sweep, which finds
    // the global-partner IBAN match and must localize it.
    await db.collection("partners").doc("p-unrelated").set({
      userId: USER,
      name: "Totally Different Vendor",
      aliases: [],
      ibans: [IBAN_B],
      isActive: true,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
    await drainTriggers();

    const tx = (await db.collection("transactions").doc("t-flix").get()).data()!;
    expect(tx.partnerType).toBe("user"); // localized, not assigned as global
    expect(tx.partnerId).not.toBe("g-netflix");
    expect(tx.partnerMatchedBy).toBe("auto");

    const local = (await db.collection("partners").doc(tx.partnerId as string).get()).data()!;
    expect(local.globalPartnerId).toBe("g-netflix");
    expect(local.createdBy).toBe("auto_partner_match");
    expect(local.userId).toBe(USER);

    // Loop prevention: the localized partner's own create event ran through
    // onPartnerCreate and self-skipped — exactly one local Netflix partner.
    const netflixPartners = await db
      .collection("partners")
      .where("userId", "==", USER)
      .where("globalPartnerId", "==", "g-netflix")
      .get();
    expect(netflixPartners.size).toBe(1);
  });
});

describe("selfhost hardening: onPartnerUpdate file re-match chain", () => {
  async function seedPartnerA(ibans: string[]) {
    await db.collection("partners").doc("p-a").set({
      userId: USER,
      name: "Alpha Hosting GmbH",
      aliases: [],
      ibans,
      isActive: true,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
    await drainTriggers();
  }

  it("re-evaluates files on IBAN change: clears stale auto-match, claims waiting file", async () => {
    await seedPartnerA([IBAN_A]);
    await db.collection("files").doc("f-stale").set(
      baseFile({
        partnerId: "p-a",
        partnerMatchedBy: "auto",
        extractedIban: IBAN_A,
      }),
    );
    await db.collection("files").doc("f-waiting").set(
      baseFile({
        partnerId: null,
        extractedIban: IBAN_B,
      }),
    );
    await drainTriggers();

    // Partner's IBAN corrected: A was wrong, B is right.
    await db.collection("partners").doc("p-a").update({
      ibans: [IBAN_B],
      updatedAt: Timestamp.now(),
    });
    await drainTriggers();

    const stale = (await db.collection("files").doc("f-stale").get()).data()!;
    expect(stale.partnerId ?? null).toBeNull(); // cleared, no confident match left
    expect(stale.partnerMatchedBy ?? null).toBeNull();

    const waiting = (await db.collection("files").doc("f-waiting").get()).data()!;
    expect(waiting.partnerId).toBe("p-a"); // claimed via the new IBAN
    expect(waiting.partnerMatchedBy).toBe("auto");
    expect(waiting.partnerMatchConfidence).toBe(100);
  });

  it("does not touch manually assigned files on partner update", async () => {
    await seedPartnerA([IBAN_A]);
    await db.collection("files").doc("f-manual").set(
      baseFile({
        partnerId: "p-a",
        partnerMatchedBy: "manual",
        extractedIban: IBAN_A,
      }),
    );
    await drainTriggers();

    await db.collection("partners").doc("p-a").update({
      ibans: [IBAN_B],
      updatedAt: Timestamp.now(),
    });
    await drainTriggers();

    const manual = (await db.collection("files").doc("f-manual").get()).data()!;
    expect(manual.partnerId).toBe("p-a"); // manual assignment is sacred
    expect(manual.partnerMatchedBy).toBe("manual");
  });

  it("re-matches orphaned files to remaining partners on soft-delete", async () => {
    await seedPartnerA([IBAN_A]);
    await db.collection("partners").doc("p-b").set({
      userId: USER,
      name: "Beta Services Ltd",
      aliases: [],
      ibans: [IBAN_B],
      isActive: true,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
    await drainTriggers();

    // File orphaned earlier (deleteUserPartner clears partnerId before the
    // soft-delete write) whose IBAN actually belongs to the OTHER partner.
    await db.collection("files").doc("f-orphan").set(
      baseFile({
        partnerId: null,
        extractedIban: IBAN_B,
      }),
    );
    await drainTriggers();

    await db.collection("partners").doc("p-a").update({
      isActive: false,
      updatedAt: Timestamp.now(),
    });
    await drainTriggers();

    const orphan = (await db.collection("files").doc("f-orphan").get()).data()!;
    expect(orphan.partnerId).toBe("p-b");
    expect(orphan.partnerMatchedBy).toBe("auto");
  });
});
