/**
 * #341 — a counterparty entity with no `name` must not abort the identity
 * re-calc batch.
 *
 * The follow-up to #294: of the five counterparty copies onUserDataUpdate
 * writes, `extractedPartner` is the one derived from `name`, and `name` is not
 * required on a stored entity. Writing it as `undefined` makes the batch
 * commit throw on the selfhost shim (which, like Firestore, never enables
 * `ignoreUndefinedProperties`) and drops every other File in that batch.
 *
 * The real trigger module runs unmodified on the selfhost shims.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";

// REAL trigger module, unmodified:
import "../matching/onUserDataUpdate";

const db = getFirestore();
const USER = "stefan-test";
const USER_VAT = "ATU99999999";

const userDataRef = () =>
  db.collection("users").doc(USER).collection("settings").doc("userData");

async function seedFile(
  fileId: string,
  extractedIssuer: Record<string, unknown>,
  stale: Record<string, unknown>,
) {
  await db.collection("files").doc(fileId).set({
    userId: USER,
    fileName: `${fileId}.pdf`,
    fileType: "application/pdf",
    extractionComplete: true,
    extractedIssuer,
    extractedRecipient: { name: "Stefan Bandit", vatId: USER_VAT },
    invoiceDirection: "incoming",
    matchedUserAccount: "recipient",
    recipientIdentityMatch: "user",
    partnerId: null,
    partnerMatchedBy: null,
    partnerMatchComplete: false,
    transactionIds: [],
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
    ...stale,
  });
}

/** A matching-relevant identity edit, so the sweep runs over every File. */
async function editIdentity(ibans: string[]) {
  await userDataRef().update({
    personalEntity: { name: "Stefan Bandit", vatId: USER_VAT, ibans },
  });
  await drainTriggers();
}

const file = async (id: string) => (await db.collection("files").doc(id).get()).data()!;

beforeEach(async () => {
  await __resetFirestoreShim();
  __resetTriggerShim();
  await userDataRef().set({
    personalEntity: { name: "Stefan Bandit", vatId: USER_VAT, ibans: [] },
  });
  await drainTriggers();
});

describe("selfhost: onUserDataUpdate survives a counterparty with no name (#341)", () => {
  it("writes the absent name as null, clearing the stale one, and commits the rest of the batch", async () => {
    await seedFile(
      "f-nameless",
      // No `name` key at all; the entity is identified by its VAT ID alone.
      { vatId: "ATU12121212", iban: "AT483200000012345864" },
      { extractedPartner: "Old Stale Vendor Name" },
    );

    // A second File in the same sweep, also due for an update. If the
    // nameless one still threw on write, this one would never be written.
    await seedFile(
      "f-named",
      { name: "Complete Vendor", vatId: "ATU12345678" },
      { extractedPartner: "Old Stale Complete Vendor Name" },
    );
    await drainTriggers();

    await editIdentity(["AT611904300234573201"]);

    const nameless = await file("f-nameless");
    expect(nameless.extractedPartner).toBeNull();
    expect(nameless.extractedVatId).toBe("ATU12121212");
    expect(nameless.extractedIban).toBe("AT483200000012345864");

    const named = await file("f-named");
    expect(named.extractedPartner).toBe("Complete Vendor");
    expect(named.extractedVatId).toBe("ATU12345678");
  });

  it("reads a nameless counterparty over a null extractedPartner as already correct", async () => {
    // The change check compared `undefined` (no name) with the stored `null`,
    // so a File whose counterparty has no name was rewritten on every sweep —
    // and each rewrite re-armed partner matching, wiping a Partner the user
    // had assigned by hand.
    await seedFile(
      "f-nameless",
      { vatId: "ATU12121212" },
      {
        extractedPartner: null,
        extractedVatId: "ATU12121212",
        extractedIban: null,
        extractedAddress: null,
        extractedWebsite: null,
        partnerId: "p-assigned",
        partnerMatchedBy: "manual",
        partnerMatchComplete: true,
      },
    );
    await drainTriggers();

    await editIdentity(["AT611904300234573201"]);

    const nameless = await file("f-nameless");
    expect(nameless.extractedPartner).toBeNull();
    expect(nameless.partnerId).toBe("p-assigned");
    expect(nameless.partnerMatchedBy).toBe("manual");
    expect(nameless.partnerMatchComplete).toBe(true);
  });
});
