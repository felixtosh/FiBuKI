/**
 * Regression test — the identity-change sweep must not re-encode a partner name.
 *
 * onUserDataUpdate re-derives extractedPartner from the STORED
 * extractedIssuer/extractedRecipient entities, which hold the raw extraction
 * and so still carry "&amp;". extractionCore decodes on the way in (#233); if
 * this sweep does not decode identically, saving identity data writes the
 * entity back over a clean name and — because the sweep also resets partner
 * matching whenever the name moves — splits the company into an encoded and a
 * decoded Partner.
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

async function seedFileWithEncodedIssuer(fileId: string, extractedPartner: string) {
  await db.collection("files").doc(fileId).set({
    userId: USER,
    fileName: "uber-receipt.pdf",
    fileType: "application/pdf",
    extractionComplete: true,
    // What the model handed back, stored verbatim: still HTML-encoded.
    // Every counterparty field is present so this fixture exercises the
    // encoding question alone; an incomplete entity is #294's case, and the
    // sweep guards those copies with `|| null` since.
    extractedIssuer: {
      name: "AL&amp;FA Taxi KG",
      vatId: "ATU12345678",
      iban: "AT021420020010147558",
      address: "Wien",
      website: "alfa-taxi.at",
    },
    extractedRecipient: { name: "Stefan Bandit", vatId: USER_VAT },
    extractedPartner,
    invoiceDirection: "incoming",
    matchedUserAccount: "recipient",
    recipientIdentityMatch: "user",
    partnerId: "p-alfa",
    partnerMatchedBy: "auto",
    partnerMatchComplete: true,
    transactionIds: [],
    createdAt: Timestamp.now(),
    updatedAt: Timestamp.now(),
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

describe("selfhost: onUserDataUpdate counterparty re-calculation (#233)", () => {
  it("leaves a decoded partner name alone instead of writing the entity back", async () => {
    await seedFileWithEncodedIssuer("f-alfa", "AL&FA Taxi KG");
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

    const file = (await db.collection("files").doc("f-alfa").get()).data()!;
    expect(file.extractedPartner).toBe("AL&FA Taxi KG");
    // Name did not move, so partner matching is not reset and the Partner
    // this file already points at survives.
    expect(file.partnerId).toBe("p-alfa");
    expect(file.partnerMatchComplete).toBe(true);
  });

  it("decodes a legacy record whose stored partner still holds the entity", async () => {
    await seedFileWithEncodedIssuer("f-legacy", "AL&amp;FA Taxi KG");
    await drainTriggers();

    await userDataRef().update({
      personalEntity: {
        name: "Stefan Bandit",
        vatId: USER_VAT,
        ibans: ["AT611904300234573201"],
      },
    });
    await drainTriggers();

    const file = (await db.collection("files").doc("f-legacy").get()).data()!;
    expect(file.extractedPartner).toBe("AL&FA Taxi KG");
  });
});

/**
 * #299: the sweep also MATCHES on the stored entity names, not just rewrites
 * extractedPartner from them. Entities written since entity normalisation
 * started decoding are already clean, and `backfillFileEntityNames` repairs
 * the older ones — but a record that predates both still holds "&amp;", and
 * on that record the name lane was comparing an encoded document name against
 * the user's own company as typed. Decoding ahead of the match is what fixes
 * the direction rather than only the string.
 */
describe("selfhost: onUserDataUpdate name-lane matching on an encoded entity (#299)", () => {
  const emptyFields = { vatId: "", iban: "", address: "", website: "" };

  async function seedUndirectedFile(): Promise<void> {
    await db.collection("files").doc("f-own-amp").set({
      userId: USER,
      fileName: "outgoing-invoice.pdf",
      fileType: "application/pdf",
      extractionComplete: true,
      // Written before the decode moved to entity normalisation.
      extractedIssuer: { name: "AL&amp;FA", ...emptyFields },
      extractedRecipient: { name: "Wiener Handels GmbH", ...emptyFields },
      extractedPartner: "AL&FA",
      invoiceDirection: "unknown",
      matchedUserAccount: null,
      recipientIdentityMatch: "third-party",
      transactionIds: [],
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
  }

  it("recognises the user's own '&' company as the issuer and makes the document outgoing", async () => {
    await userDataRef().set({
      personalEntity: { name: "Stefan Bandit", vatId: USER_VAT, ibans: [] },
      companies: [{ name: "AL&FA Taxi KG", aliases: [], ibans: [] }],
    });
    await drainTriggers();

    await seedUndirectedFile();
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

    const file = (await db.collection("files").doc("f-own-amp").get()).data()!;
    expect(file.invoiceDirection).toBe("outgoing");
    expect(file.matchedUserAccount).toBe("issuer");
    // The counterparty is the recipient, not the user's own company.
    expect(file.extractedPartner).toBe("Wiener Handels GmbH");
  });
});
