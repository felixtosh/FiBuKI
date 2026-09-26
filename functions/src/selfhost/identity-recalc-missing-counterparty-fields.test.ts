/**
 * #294 — a counterparty entity missing any of vatId/iban/address/website
 * must not abort the identity re-calc batch.
 *
 * onUserDataUpdate copies those four fields straight off the stored
 * extractedIssuer/extractedRecipient entity. Firestore (and the selfhost
 * shim, which mirrors it) rejects `undefined` in a write, and this sweep
 * writes every affected file through ONE shared batch — so a single file
 * whose counterparty is missing an optional field used to throw on
 * `batch.update()` and take every other file in that batch down with it.
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

beforeEach(async () => {
  await __resetFirestoreShim();
  __resetTriggerShim();
  await userDataRef().set({
    personalEntity: { name: "Stefan Bandit", vatId: USER_VAT, ibans: [] },
  });
  await drainTriggers();
});

describe("selfhost: onUserDataUpdate survives an incomplete counterparty (#294)", () => {
  it("writes null for missing fields and still commits the rest of the batch", async () => {
    // Missing vatId, iban, address and website entirely — an ordinary shape,
    // since none of the four is required on an extracted entity.
    await seedFile(
      "f-incomplete",
      { name: "Incomplete Vendor" },
      {
        // Stale values from a prior, more complete extraction. They must be
        // cleared to null, not left behind, once the new counterparty lacks
        // the field.
        extractedPartner: "Old Stale Vendor Name",
        extractedVatId: "ATU00000000",
        extractedIban: "AT000000000000000000",
        extractedAddress: "Old Address 1, Vienna",
        extractedWebsite: "old-vendor.example",
      },
    );

    // A second file in the same sweep, with a complete counterparty, also
    // due for an update. If the incomplete file above still threw on write,
    // this file would never be reached.
    await seedFile(
      "f-complete",
      {
        name: "Complete Vendor",
        vatId: "ATU12345678",
        iban: "AT021420020010147558",
        address: "Kärntner Straße 1, Wien",
        website: "complete-vendor.at",
      },
      { extractedPartner: "Old Stale Complete Vendor Name" },
    );

    await drainTriggers();

    // A matching-relevant identity edit: adds an IBAN, so the sweep runs.
    await userDataRef().update({
      personalEntity: {
        name: "Stefan Bandit",
        vatId: USER_VAT,
        ibans: ["AT611904300234573201"],
      },
    });
    await drainTriggers();

    const incomplete = (await db.collection("files").doc("f-incomplete").get()).data()!;
    expect(incomplete.extractedPartner).toBe("Incomplete Vendor");
    expect(incomplete.extractedVatId).toBeNull();
    expect(incomplete.extractedIban).toBeNull();
    expect(incomplete.extractedAddress).toBeNull();
    expect(incomplete.extractedWebsite).toBeNull();

    // The other file in the same batch commit was not dropped.
    const complete = (await db.collection("files").doc("f-complete").get()).data()!;
    expect(complete.extractedPartner).toBe("Complete Vendor");
    expect(complete.extractedVatId).toBe("ATU12345678");
    expect(complete.extractedIban).toBe("AT021420020010147558");
    expect(complete.extractedAddress).toBe("Kärntner Straße 1, Wien");
    expect(complete.extractedWebsite).toBe("complete-vendor.at");
  });
});
