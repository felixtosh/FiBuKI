/**
 * A Partner Merge must not re-run file matching (#306).
 *
 * The real trigger and the real merge, side by side on the shim: merging two
 * Partners writes both of them — the survivor gains the loser's IBAN, the loser
 * becomes a Merged Partner — and each write reaches `onPartnerUpdate`, whose
 * job is to re-evaluate up to 200 Files whenever identifying data changes. A
 * Merge deliberately does not re-run the Match (#262, ADR-0005), so neither
 * write may set that off.
 *
 * The contrast test is the point of the guard: the same IBAN arriving by hand
 * MUST re-evaluate the files, or the trigger has no reason to exist.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";

// REAL trigger module, unmodified:
import "../matching/onPartnerUpdate";
import { mergeUserPartnersInternal } from "../partners/mergeUserPartners";

const db = getFirestore();
const USER = "stefan-merge-306";
const IBAN_SURVIVOR = "AT611904300234573201";
const IBAN_LOSER = "DE89370400440532013000";

function basePartner(name: string, overrides: Record<string, unknown> = {}) {
  return {
    userId: USER,
    name,
    aliases: [],
    ibans: [],
    isActive: true,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    ...overrides,
  };
}

function baseFile(overrides: Record<string, unknown> = {}) {
  return {
    userId: USER,
    fileName: "rechnung.pdf",
    fileType: "application/pdf",
    extractionComplete: true,
    partnerMatchComplete: true,
    transactionIds: [],
    partnerId: null,
    extractedPartner: null,
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    ...overrides,
  };
}

/**
 * Seed the pair and the File the loser's IBAN would hand to the survivor.
 * The File is unmatched, so nothing about it is repointed by the merge itself —
 * only a re-match could touch it.
 */
async function seedPair(): Promise<void> {
  await db.collection("partners").doc("p-survivor").set(
    basePartner("Alpha Hosting GmbH", { ibans: [IBAN_SURVIVOR] }),
  );
  await db.collection("partners").doc("p-loser").set(
    basePartner("Alpha Hosting G.m.b.H.", { ibans: [IBAN_LOSER] }),
  );
  await db.collection("files").doc("f-waiting").set(
    baseFile({ extractedIban: IBAN_LOSER }),
  );
  await drainTriggers(); // flush the seed events before the write under test
}

beforeEach(async () => {
  await __resetFirestoreShim();
  __resetTriggerShim();
});

describe("selfhost hardening: a Merge does not re-run file matching (#306)", () => {
  it("merges two partners without the survivor write re-matching any file", async () => {
    await seedPair();

    const result = await mergeUserPartnersInternal(
      db as unknown as FirebaseFirestore.Firestore,
      USER,
      { survivorId: "p-survivor", loserIds: ["p-loser"] },
    );
    await drainTriggers();

    // The merge did happen: the survivor holds both IBANs and the loser is a
    // Merged Partner, so the trigger had every reason to fire.
    const survivor = (await db.collection("partners").doc("p-survivor").get()).data()!;
    expect(survivor.ibans).toEqual([IBAN_SURVIVOR, IBAN_LOSER]);
    expect(result.aliasesAdded).toContain("Alpha Hosting G.m.b.H.");

    const loser = (await db.collection("partners").doc("p-loser").get()).data()!;
    expect(loser.mergedInto).toBe("p-survivor");

    // Both writes carry the same marker — one mechanism, both sides.
    expect(typeof survivor.mergeWriteId).toBe("string");
    expect(loser.mergeWriteId).toBe(survivor.mergeWriteId);

    // No re-match ran: the file the survivor's new IBAN would have claimed is
    // untouched, down to the fields a re-match writes even when it changes
    // nothing (`partnerSuggestions`, `partnerMatchedAt`).
    const waiting = (await db.collection("files").doc("f-waiting").get()).data()!;
    expect(waiting.partnerId ?? null).toBeNull();
    expect(waiting.partnerSuggestions ?? null).toBeNull();
    expect(waiting.partnerMatchedAt ?? null).toBeNull();
  });

  it("still re-matches when an alias is edited by hand", async () => {
    await seedPair();
    await db.collection("files").doc("f-name").set(
      baseFile({ extractedPartner: "Alpha Webhosting" }),
    );
    await drainTriggers();

    await db.collection("partners").doc("p-survivor").update({
      aliases: ["Alpha Webhosting"],
      updatedAt: Timestamp.now(),
    });
    await drainTriggers();

    const byName = (await db.collection("files").doc("f-name").get()).data()!;
    expect(byName.partnerId).toBe("p-survivor");
    expect(byName.partnerMatchedBy).toBe("auto");
  });

  it("re-matches nothing when a Merge takes a loser already merged into another", async () => {
    await seedPair();
    await db.collection("partners").doc("p-second").set(
      basePartner("Alpha Hosting AG", { ibans: [] }),
    );
    await drainTriggers();

    // First merge builds the chain: p-loser is now a Merged Partner of p-second.
    await mergeUserPartnersInternal(
      db as unknown as FirebaseFirestore.Firestore,
      USER,
      { survivorId: "p-second", loserIds: ["p-loser"] },
    );
    await drainTriggers();

    // Second merge takes BOTH, so p-loser is written twice by one merge: once
    // as a chained tombstone repointed at the survivor, once as this merge's
    // own tombstone. The second of those carries the id it already holds, so
    // the marker does not recognise it — a merged-away Partner is inactive by
    // then and the trigger leaves it alone regardless, but the file below is
    // what the criterion is about and it must stay untouched either way.
    await mergeUserPartnersInternal(
      db as unknown as FirebaseFirestore.Firestore,
      USER,
      { survivorId: "p-survivor", loserIds: ["p-loser", "p-second"] },
    );
    await drainTriggers();

    expect((await db.collection("partners").doc("p-loser").get()).data()!.mergedInto)
      .toBe("p-survivor");

    const waiting = (await db.collection("files").doc("f-waiting").get()).data()!;
    expect(waiting.partnerId ?? null).toBeNull();
    expect(waiting.partnerSuggestions ?? null).toBeNull();
    expect(waiting.partnerMatchedAt ?? null).toBeNull();
  });

  it("still re-matches a hand-edited alias on a Partner a Merge wrote before", async () => {
    await seedPair();
    await mergeUserPartnersInternal(
      db as unknown as FirebaseFirestore.Firestore,
      USER,
      { survivorId: "p-survivor", loserIds: ["p-loser"] },
    );
    await drainTriggers();

    // The marker is still on the document. It suppresses the write that brought
    // it, not every write afterwards: this alias edit carries the same id the
    // survivor already held, so it is somebody else's write and must re-match.
    await db.collection("files").doc("f-name").set(
      baseFile({ extractedPartner: "Alpha Webhosting" }),
    );
    await drainTriggers();

    await db.collection("partners").doc("p-survivor").update({
      aliases: ["Alpha Webhosting"],
      updatedAt: Timestamp.now(),
    });
    await drainTriggers();

    const byName = (await db.collection("files").doc("f-name").get()).data()!;
    expect(byName.partnerId).toBe("p-survivor");
    expect(byName.partnerMatchedBy).toBe("auto");
  });
});
