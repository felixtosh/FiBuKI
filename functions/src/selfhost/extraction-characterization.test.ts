/**
 * CHARACTERIZATION tests — extraction pipeline orchestration on the selfhost
 * shims, written ahead of the platform rewrite.
 *
 * Pins the CURRENT deterministic behavior of runExtraction (extractionCore),
 * retryFileExtraction, and the extractFileData triggers — bugs and quirks
 * included (marked `// characterization: ...`). REAL application code runs
 * unmodified; only the boundaries are swapped:
 *  - firebase-admin/firestore + storage + functions surface → selfhost shims
 *    (module aliases in vitest.selfhost.config.ts)
 *  - `@google-cloud/vertexai` → vi.mock with a queue of canned Gemini
 *    responses (the model/network boundary)
 *
 * Covered domain logic: two-phase classification writes, not-an-invoice
 * clearing, counterparty determination (VAT/IBAN/name matching, direction),
 * legacy partner fallback, line-item normalization/reconciliation/fallback,
 * net-vs-gross total inference, ISO-date → local-time Timestamp conversion,
 * confidence rounding, raw-text counterparty overrides, retry gating/reset
 * semantics, and trigger guards.
 *
 * Retry and the triggers queue the Extraction and return (#603); the tests
 * run the queue with drainExtractionQueue, as the worker would.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { MODELS } from "../utils/models";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";
import { drainExtractionQueue } from "./extraction-worker";
import { getStorage } from "./storage-shim";

// ---------------------------------------------------------------------------
// Gemini boundary mock (replaces the vertexai stub with a scriptable queue)
// ---------------------------------------------------------------------------

const gemini = vi.hoisted(() => ({
  queue: [] as string[],
  requests: [] as unknown[],
}));

vi.mock("@google-cloud/vertexai", () => ({
  VertexAI: class {
    getGenerativeModel() {
      return {
        generateContent: async (req: unknown) => {
          gemini.requests.push(req);
          return {
            response: {
              candidates: [
                { content: { role: "model", parts: [{ text: gemini.queue.shift() ?? "{}" }] } },
              ],
              usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 },
            },
          };
        },
      };
    }
  },
}));

// REAL application code, unmodified:
import { runExtraction } from "../extraction/extractionCore";
import { retryFileExtraction } from "../extraction/retryExtraction";

const db = getFirestore();
const USER = "stefan-test";
const STORAGE_PATH = "uploads/char-test.jpg";

function q(response: Record<string, unknown> | string): void {
  gemini.queue.push(typeof response === "string" ? response : JSON.stringify(response));
}

async function seedFile(fileId: string, extra: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {
    userId: USER,
    storagePath: STORAGE_PATH,
    fileType: "image/jpeg",
    fileName: "char-test.jpg",
    extractionComplete: false,
    ...extra,
  };
  // An `undefined` override means "field absent": real Firestore docs can
  // never hold undefined (the shim now rejects it like firebase-admin), so
  // drop the key instead of writing it.
  for (const key of Object.keys(data)) {
    if (data[key] === undefined) delete data[key];
  }
  await db.collection("files").doc(fileId).set(data);
  return data;
}

async function fileDoc(fileId: string): Promise<Record<string, unknown>> {
  return (await db.collection("files").doc(fileId).get()).data()!;
}

async function seedUserData(data: Record<string, unknown>): Promise<void> {
  await db.collection("users").doc(USER).collection("settings").doc("userData").set(data);
}

beforeAll(() => {
  process.env.GCLOUD_PROJECT = "char-test-project";
  process.env.FIBUKI_STORAGE = "memory";
  process.env.ANTHROPIC_API_KEY = "test-anthropic-key";
  delete process.env.GEMINI_MODEL;
});

beforeEach(async () => {
  // Let stragglers from the previous test land before the reset.
  await __whenShimIdle(); // the previous test's fire-and-forget writes, finished
  await __resetFirestoreShim();
  __resetTriggerShim();
  gemini.queue.length = 0;
  gemini.requests.length = 0;
  await getStorage().bucket().file(STORAGE_PATH).save(Buffer.from("fake-image-bytes"));
});

// ===========================================================================
// runExtraction — classification phase
// ===========================================================================

describe("characterization: runExtraction classification phase", () => {
  it("not-an-invoice: saves classification, clears all extracted fields, skips extraction", async () => {
    const fileData = await seedFile("f-notinv");
    q({ isInvoice: false, reason: "Bank statement", confidence: 0.9 });

    const res = await runExtraction("f-notinv", fileData, {});
    expect(res.success).toBe(true);
    expect(gemini.requests).toHaveLength(1); // classification only, no extraction call

    const doc = await fileDoc("f-notinv");
    expect(doc.classificationComplete).toBe(true);
    expect(doc.isNotInvoice).toBe(true);
    expect(doc.notInvoiceReason).toBe("Bank statement");
    expect(doc.extractionComplete).toBe(true);
    expect(doc.extractionError).toBeNull();
    expect(doc.extractionConfidence).toBe(90); // round(0.9 * 100)
    expect(doc.extractedText).toBe("(classification only - not an invoice)");
    expect(doc.extractedFields).toEqual([]);
    // every extracted field is explicitly nulled
    for (const field of [
      "extractedDate",
      "extractedAmount",
      "extractedCurrency",
      "extractedVatPercent",
      "extractedVatAmount",
      "extractedLineItems",
      "extractedPartner",
      "extractedVatId",
      "extractedIban",
      "extractedAddress",
      "extractedWebsite",
      "extractedRaw",
      "extractedAdditionalFields",
    ]) {
      expect(doc[field], field).toBeNull();
    }

    // classification token usage is logged to aiUsage
    const usage = await db.collection("aiUsage").where("userId", "==", USER).get();
    expect(usage.size).toBe(1);
    expect(usage.docs[0].data().function).toBe("classification");
    expect(usage.docs[0].data().model).toBe(MODELS.geminiLite);
    expect(usage.docs[0].data().inputTokens).toBe(11);
    expect(usage.docs[0].data().outputTokens).toBe(7);
  });

  it("skipClassification marks the file as a user-confirmed invoice without a classify call", async () => {
    const fileData = await seedFile("f-skip");
    q({ extracted: { amount: 4200, vatPercent: 19, currency: "EUR", confidence: 0.5 } });

    await runExtraction("f-skip", fileData, { skipClassification: true });
    expect(gemini.requests).toHaveLength(1); // extraction only

    const doc = await fileDoc("f-skip");
    expect(doc.classificationComplete).toBe(true);
    expect(doc.isNotInvoice).toBe(false);
    expect(doc.notInvoiceReason).toBeNull();
    // no line items → document-level values pass through untouched
    expect(doc.extractedAmount).toBe(4200);
    expect(doc.extractedVatPercent).toBe(19);
    expect(doc.extractedVatAmount).toBeNull();
    expect(doc.extractedLineItems).toBeNull();
    expect(doc.extractedCurrency).toBe("EUR");
    expect(doc.extractedDate).toBeUndefined(); // no date → field simply not written
  });

  it("throws when the file has no storagePath", async () => {
    await expect(runExtraction("f-nopath", { userId: USER }, {})).rejects.toThrow(
      "No storage path found for file",
    );
  });
});

// ===========================================================================
// runExtraction — full extraction, counterparty & shaping
// ===========================================================================

describe("characterization: runExtraction extraction + counterparty", () => {
  it("incoming invoice: recipient matches user VAT id → issuer becomes the partner", async () => {
    await seedUserData({
      personalEntity: { name: "Stefan Bandit", vatId: "ATU99999999" },
      companies: [{ name: "House of Bandits GmbH", vatId: "ATU12345678", ibans: ["AT61 1904 3002 3457 3201"] }],
    });
    const fileData = await seedFile("f-in");

    q({ isInvoice: true, confidence: 0.95 });
    q({
      rawText: "Rechnung Nr. 2024-001 von Vendor GmbH an House of Bandits GmbH",
      extracted: {
        date: "2024-12-15",
        date_raw: "15.12.2024",
        amount: 12000,
        amount_raw: "120,00 €",
        currency: "€",
        vatPercent: 20,
        vatPercent_raw: "20%",
        lineItems: [
          { description: "Cable", vatPercent: 20, vatAmount: 2000, amount: 12000 },
        ],
        confidence: 0.87,
        issuer: {
          name: "Vendor GmbH",
          vatId: "DE 123 456 789",
          address: "Musterstr. 1, Berlin",
          iban: "DE89 3704 0044 0532 0130 00",
          website: "https://www.vendor.de/contact",
        },
        issuer_raw: {
          name: "Vendor GmbH",
          vatId: "DE 123 456 789",
          address: "Musterstr. 1\nBerlin",
          iban: "DE89 3704 0044 0532 0130 00",
          website: "www.vendor.de",
        },
        recipient: { name: "House of Bandits GmbH", vatId: "ATU 12345678" },
        recipient_raw: { name: "House of Bandits GmbH" },
      },
      additionalFields: [
        { key: "invoiceNumber", label: "Invoice Number", value: "2024-001", rawValue: "Rechnung Nr. 2024-001" },
        { key: "invoiceNumber", label: "", value: "dropped" },
        { key: "tableNumber", label: "Tischnummer", value: "12" },
        { key: "dueDate", label: "Due Date", value: "2025-01-15" },
      ],
    });

    await runExtraction("f-in", fileData, {});
    expect(gemini.requests).toHaveLength(2); // classify + extract

    const doc = await fileDoc("f-in");
    expect(doc.classificationComplete).toBe(true);
    expect(doc.isNotInvoice).toBe(false);
    expect(doc.extractionComplete).toBe(true);
    expect(doc.extractionError).toBeNull();
    expect(doc.extractionProvider).toBe("gemini");
    expect(doc.extractionConfidence).toBe(87);
    expect(doc.extractedText).toBe("Rechnung Nr. 2024-001 von Vendor GmbH an House of Bandits GmbH");
    expect(doc.extractedFields).toEqual([]);

    // counterparty: recipient VAT (normalized) matches user's company VAT
    expect(doc.invoiceDirection).toBe("incoming");
    expect(doc.matchedUserAccount).toBe("recipient");
    expect(doc.extractedPartner).toBe("Vendor GmbH");
    expect(doc.extractedVatId).toBe("DE123456789"); // normalized (spaces stripped)
    // characterization: entity IBANs are NOT normalized — stored with spaces
    expect(doc.extractedIban).toBe("DE89 3704 0044 0532 0130 00");
    expect(doc.extractedAddress).toBe("Musterstr. 1, Berlin");
    expect(doc.extractedWebsite).toBe("vendor.de"); // domain-normalized
    expect(doc.extractedCurrency).toBe("EUR"); // "€" → EUR

    // entities stored for re-calculation
    expect(doc.extractedIssuer).toEqual({
      name: "Vendor GmbH",
      vatId: "DE123456789",
      address: "Musterstr. 1, Berlin",
      iban: "DE89 3704 0044 0532 0130 00",
      website: "vendor.de",
      // #540: from the VAT ID prefix
      country: "DE",
    });
    expect(doc.extractedRecipient).toEqual({
      name: "House of Bandits GmbH",
      vatId: "ATU12345678",
      address: null,
      iban: null,
      website: null,
      country: "AT",
    });
    expect(doc.extractedCountry).toBe("DE");

    // line items reconcile exactly with the document total
    expect(doc.extractedLineItems).toEqual([
      { description: "Cable", vatPercent: 20, vatAmount: 2000, amount: 12000 },
    ]);
    expect(doc.extractedAmount).toBe(12000);
    expect(doc.extractedVatAmount).toBe(2000);
    expect(doc.extractedVatPercent).toBe(20);

    // ISO date is stored as UTC midnight of that day, whatever the server's zone
    const ts = doc.extractedDate as Timestamp;
    expect(ts.toDate().toISOString()).toBe("2024-12-15T00:00:00.000Z");

    // raw text: counterparty (issuer) raw values override the partner raws
    expect(doc.extractedRaw).toEqual({
      date: "15.12.2024",
      amount: "120,00 €",
      vatPercent: "20%",
      partner: "Vendor GmbH",
      vatId: "DE 123 456 789", // raw keeps original spacing
      iban: "DE89 3704 0044 0532 0130 00",
      address: "Musterstr. 1\nBerlin",
      website: "www.vendor.de",
      issuer: {
        name: "Vendor GmbH",
        vatId: "DE 123 456 789",
        address: "Musterstr. 1\nBerlin",
        iban: "DE89 3704 0044 0532 0130 00",
        website: "www.vendor.de",
      },
      recipient: { name: "House of Bandits GmbH", vatId: null, address: null, iban: null, website: null },
    });

    // additional fields: empty-label entry dropped, rawValue falls back to
    // value, and a key outside the closed vocabulary never reaches the record
    // — the Tischnummer is gone (#252)
    expect(doc.extractedAdditionalFields).toEqual([
      { key: "invoiceNumber", label: "Invoice Number", value: "2024-001", rawValue: "Rechnung Nr. 2024-001" },
      { key: "dueDate", label: "Due Date", value: "2025-01-15", rawValue: "2025-01-15" },
    ]);

    // both phases logged token usage
    const usage = await db.collection("aiUsage").where("userId", "==", USER).get();
    expect(usage.docs.map((d) => d.data().function).sort()).toEqual(["classification", "extraction"]);
  });

  it("outgoing invoice: issuer matches a connected bank account IBAN → recipient is partner", async () => {
    await seedUserData({ personalEntity: { name: "Zed Unrelated" } });
    // source IBAN is normalized (uppercase, spaces stripped) before comparison
    await db.collection("sources").doc("src-1").set({
      userId: USER,
      isActive: true,
      iban: "at61 1904 3002 3457 3201",
    });
    const fileData = await seedFile("f-out");

    q({
      extracted: {
        amount: 5000,
        confidence: 0.8,
        issuer: { name: "My Own Firm", iban: "AT61 1904 3002 3457 3201" },
        issuer_raw: { name: "My Own Firm GmbH", iban: "AT61 1904 3002 3457 3201" },
        recipient: { name: "Client Co", vatId: "DE 999 888 777" },
        recipient_raw: { name: "Client Co Ltd." },
      },
    });
    await runExtraction("f-out", fileData, { skipClassification: true });

    const doc = await fileDoc("f-out");
    expect(doc.invoiceDirection).toBe("outgoing");
    expect(doc.matchedUserAccount).toBe("issuer");
    expect(doc.extractedPartner).toBe("Client Co");
    expect(doc.extractedVatId).toBe("DE999888777");
    // counterparty has no IBAN/website/address → fields are written as null,
    // so a re-extraction never keeps the previous run's value (#376)
    expect(doc.extractedIban).toBeNull();
    expect(doc.extractedAddress).toBeNull();
    expect(doc.extractedWebsite).toBeNull();
    // raw partner overridden with the counterparty's raw name…
    expect((doc.extractedRaw as Record<string, unknown>).partner).toBe("Client Co Ltd.");
    // characterization: …but raw IBAN falls back to the ISSUER's raw IBAN
    // (counterparty has none, and `||` keeps the previous value) — the raw
    // highlight text points at the user's own IBAN while extractedIban is unset
    expect((doc.extractedRaw as Record<string, unknown>).iban).toBe("AT61 1904 3002 3457 3201");
  });

  it("both entities match user → treated as outgoing, recipient is counterparty", async () => {
    await seedUserData({
      personalEntity: { name: "Stefan Bandit" },
      companies: [{ name: "House of Bandits GmbH" }],
    });
    const fileData = await seedFile("f-both");
    q({
      extracted: {
        amount: 100,
        confidence: 1,
        issuer: { name: "House of Bandits GmbH" },
        recipient: { name: "Stefan Bandit" },
        recipient_raw: { name: "Herr Stefan Bandit" },
      },
    });
    await runExtraction("f-both", fileData, { skipClassification: true });

    const doc = await fileDoc("f-both");
    expect(doc.invoiceDirection).toBe("outgoing");
    expect(doc.matchedUserAccount).toBe("issuer");
    expect(doc.extractedPartner).toBe("Stefan Bandit");
    expect((doc.extractedRaw as Record<string, unknown>).partner).toBe("Herr Stefan Bandit");
  });

  it("neither entity matches user → direction unknown, issuer defaults to partner", async () => {
    await seedUserData({ personalEntity: { name: "Zzz Person" } });
    const fileData = await seedFile("f-neither");
    q({
      extracted: {
        amount: 100,
        confidence: 1,
        issuer: { name: "A Corp" },
        recipient: { name: "B Corp" },
      },
    });
    await runExtraction("f-neither", fileData, { skipClassification: true });

    const doc = await fileDoc("f-neither");
    expect(doc.invoiceDirection).toBe("unknown");
    expect(doc.matchedUserAccount).toBeNull();
    expect(doc.extractedPartner).toBe("A Corp");
  });

  it("no user data configured → direction unknown, issuer defaults to partner", async () => {
    const fileData = await seedFile("f-nouser");
    q({
      extracted: {
        amount: 100,
        confidence: 1,
        issuer: { name: "A Corp" },
        recipient: { name: "B Corp" },
      },
    });
    await runExtraction("f-nouser", fileData, { skipClassification: true });

    const doc = await fileDoc("f-nouser");
    expect(doc.invoiceDirection).toBe("unknown");
    expect(doc.matchedUserAccount).toBeNull();
    expect(doc.extractedPartner).toBe("A Corp");
  });

  it("legacy path (no entities): partner matching the user still becomes extractedPartner", async () => {
    await seedUserData({ companies: [{ name: "House of Bandits GmbH" }] });
    const fileData = await seedFile("f-legacy");
    q({
      extracted: {
        partner: "House of Bandits GmbH",
        amount: 4200,
        vatPercent: 19,
        currency: "EUR",
        confidence: 0.5,
      },
    });
    await runExtraction("f-legacy", fileData, { skipClassification: true });

    const doc = await fileDoc("f-legacy");
    // legacy direction detection recognises the user as issuer…
    expect(doc.invoiceDirection).toBe("outgoing");
    expect(doc.matchedUserAccount).toBeNull();
    // characterization: preserves current behavior — with no entity data the
    // user's OWN company name is stored as extractedPartner on outgoing invoices
    expect(doc.extractedPartner).toBe("House of Bandits GmbH");
    expect(doc.extractedIssuer).toBeNull();
    expect(doc.extractedRecipient).toBeNull();
  });

  it("#233: a counterparty name with HTML entities is decoded before it becomes extractedPartner", async () => {
    const fileData = await seedFile("f-entity-counterparty");
    q({
      extracted: {
        amount: 100,
        confidence: 1,
        issuer: { name: "AL&amp;FA Taxi KG" },
      },
    });
    await runExtraction("f-entity-counterparty", fileData, { skipClassification: true });

    const doc = await fileDoc("f-entity-counterparty");
    expect(doc.extractedPartner).toBe("AL&FA Taxi KG");
  });

  it("#233: the legacy partner fallback decodes HTML entities too", async () => {
    const fileData = await seedFile("f-entity-legacy");
    q({
      extracted: {
        partner: "AL&amp;FA Taxi KG",
        amount: 100,
        confidence: 1,
      },
    });
    await runExtraction("f-entity-legacy", fileData, { skipClassification: true });

    const doc = await fileDoc("f-entity-legacy");
    expect(doc.extractedPartner).toBe("AL&FA Taxi KG");
  });

  it("#299: the user's own company with an '&' matches their entity, and the direction follows", async () => {
    // The registered name is what the user typed; the document's issuer block
    // prints the shorter trade name. Encoded, the inserted "amp" token breaks
    // the substring lane and the user does not match their own company — the
    // document lands undirected. Decoded at entity normalisation, the issuer
    // IS the user, so this is an outgoing invoice and the counterparty is the
    // recipient, not the issuer.
    await seedUserData({ companies: [{ name: "AL&FA Taxi KG" }] });
    const fileData = await seedFile("f-own-amp-issuer");
    q({
      extracted: {
        amount: 100,
        confidence: 1,
        issuer: { name: "AL&amp;FA" },
        recipient: { name: "Wiener Handels GmbH" },
      },
    });
    await runExtraction("f-own-amp-issuer", fileData, { skipClassification: true });

    const doc = await fileDoc("f-own-amp-issuer");
    expect(doc.invoiceDirection).toBe("outgoing");
    expect(doc.matchedUserAccount).toBe("issuer");
    expect(doc.extractedPartner).toBe("Wiener Handels GmbH");
    // Stored decoded, so the next reader — the onUserDataUpdate sweep, export,
    // Partner display — inherits the same spelling.
    expect((doc.extractedIssuer as Record<string, unknown>).name).toBe("AL&FA");
  });

  it("#299: the same company as recipient makes the document incoming", async () => {
    await seedUserData({ companies: [{ name: "AL&FA Taxi KG" }] });
    const fileData = await seedFile("f-own-amp-recipient");
    q({
      extracted: {
        amount: 100,
        confidence: 1,
        issuer: { name: "Wiener Handels GmbH" },
        recipient: { name: "AL&amp;FA" },
      },
    });
    await runExtraction("f-own-amp-recipient", fileData, { skipClassification: true });

    const doc = await fileDoc("f-own-amp-recipient");
    expect(doc.invoiceDirection).toBe("incoming");
    expect(doc.matchedUserAccount).toBe("recipient");
    expect(doc.recipientIdentityMatch).toBe("user");
    expect(doc.extractedPartner).toBe("Wiener Handels GmbH");
    expect((doc.extractedRecipient as Record<string, unknown>).name).toBe("AL&FA");
  });

  it("#233: a name with no entity in it, including a bare ampersand, is unchanged", async () => {
    const fileData = await seedFile("f-bare-amp");
    q({
      extracted: {
        amount: 100,
        confidence: 1,
        issuer: { name: "Q & A Solutions" },
      },
    });
    await runExtraction("f-bare-amp", fileData, { skipClassification: true });

    const doc = await fileDoc("f-bare-amp");
    expect(doc.extractedPartner).toBe("Q & A Solutions");
  });
});

// ===========================================================================
// runExtraction — line item reconciliation
// ===========================================================================

describe("characterization: runExtraction line-item reconciliation", () => {
  it("line items that badly mismatch the document total are KEPT and flagged (fork #64)", async () => {
    const fileData = await seedFile("f-mismatch");
    q({
      extracted: {
        amount: 11900,
        vatPercent: 19,
        confidence: 0.75,
        lineItems: [{ description: "Teilposten", amount: 5000, vatPercent: 19, vatAmount: 798 }],
      },
    });
    await runExtraction("f-mismatch", fileData, { skipClassification: true });

    const doc = await fileDoc("f-mismatch");
    // 5798 (net+VAT view) vs 11900 → mismatch 6102 > tolerance 60. The old
    // behavior destroyed the items with one document-rate fallback line;
    // now they survive for human repair, the file is flagged, and the
    // top-level keeps the document's own extraction (spec §6).
    expect(doc.extractedLineItems).toEqual([
      { description: "Teilposten", vatPercent: 19, vatAmount: 798, amount: 5000 },
    ]);
    expect(doc.lineItemsUnreconciled).toBe(true);
    expect(doc.extractedAmount).toBe(11900);
    // #511: the document carries one rate, so its VAT is its total at that
    // rate (11900 x 19/119) and does not go down with the broken rows.
    expect(doc.extractedVatAmount).toBe(1900);
    expect(doc.extractedVatPercent).toBe(19);
  });

  it("summary/header rows are filtered before reconciliation; mixed VAT rates → null percent", async () => {
    const fileData = await seedFile("f-filter");
    q({
      extracted: {
        amount: 1700,
        confidence: 0.9,
        lineItems: [
          { description: "Widget A", amount: 1200, vatPercent: 20, vatAmount: 200 },
          { description: "Widget B", amount: 500, vatPercent: 10, vatAmount: 45 },
          { description: "Subtotal", amount: 1700 },
          { description: "First 3 units", amount: 400 },
          { description: "VAT summary", amount: 245 },
        ],
      },
    });
    await runExtraction("f-filter", fileData, { skipClassification: true });

    const doc = await fileDoc("f-filter");
    expect(doc.extractedLineItems).toEqual([
      { description: "Widget A", vatPercent: 20, vatAmount: 200, amount: 1200 },
      { description: "Widget B", vatPercent: 10, vatAmount: 45, amount: 500 },
    ]);
    expect(doc.extractedAmount).toBe(1700);
    expect(doc.extractedVatAmount).toBe(245);
    expect(doc.extractedVatPercent).toBeNull(); // mixed 20% / 10%
  });

  it("an Austrian Beleg's Zwischensumme/Trinkgeld/Summe rows are filtered too (#252)", async () => {
    const fileData = await seedFile("f-beleg");
    q({
      extracted: {
        amount: 2250, // the VAT-bearing Summe; the tip is its own field (#172)
        tipAmount: 250,
        confidence: 0.9,
        lineItems: [
          { description: "2x Wiener Schnitzel", amount: 1800, vatPercent: 10, vatAmount: 164 },
          { description: "3x Bier 0,5l", amount: 450, vatPercent: 20, vatAmount: 75 },
          { description: "Zwischensumme", amount: 2250 },
          { description: "Trinkgeld", amount: 250 },
          { description: "Summe", amount: 2500 },
        ],
      },
    });
    await runExtraction("f-beleg", fileData, { skipClassification: true });

    const doc = await fileDoc("f-beleg");
    // Before #252 not one of the three German summary words matched, so all
    // five rows survived, summed to 7250 against a 2250 document and the file
    // was flagged unreconciled with a perfectly good itemisation on it.
    expect(doc.extractedLineItems).toEqual([
      { description: "2x Wiener Schnitzel", vatPercent: 10, vatAmount: 164, amount: 1800 },
      { description: "3x Bier 0,5l", vatPercent: 20, vatAmount: 75, amount: 450 },
    ]);
    expect(doc.lineItemsUnreconciled).toBe(false);
    expect(doc.extractedAmount).toBe(2250);
    expect(doc.extractedTipAmount).toBe(250);
    expect(doc.extractedVatPercent).toBeNull(); // mixed 10% / 20%
  });

  it("without a document total, net-looking line items get VAT added to the stored amount", async () => {
    const fileData = await seedFile("f-net");
    q({
      extracted: {
        amount: null,
        confidence: 0.6,
        lineItems: [{ description: "Dev work", amount: 1000, vatPercent: 20, vatAmount: 200 }],
      },
    });
    await runExtraction("f-net", fileData, { skipClassification: true });

    const doc = await fileDoc("f-net");
    // characterization: vatAmount 200 == 20% of 1000 → amounts inferred as NET,
    // so extractedAmount (1200) intentionally differs from the stored line item
    // amount (1000)
    expect(doc.extractedLineItems).toEqual([
      { description: "Dev work", vatPercent: 20, vatAmount: 200, amount: 1000 },
    ]);
    expect(doc.extractedAmount).toBe(1200);
    expect(doc.extractedVatAmount).toBe(200);
    expect(doc.extractedVatPercent).toBe(20);
  });
});

// ===========================================================================
// runExtraction — printed per-rate VAT summary block (fork #67, spec §6)
// ===========================================================================

describe("runExtraction: printed rate groups", () => {
  it("stores the printed block and takes the document VAT from it", async () => {
    const fileData = await seedFile("f-rg-clean");
    q({
      extracted: {
        amount: 4750,
        confidence: 0.9,
        lineItems: [
          { description: "Pasta", amount: 3850, vatPercent: 10, vatAmount: 350 },
          { description: "Wein", amount: 900, vatPercent: 20, vatAmount: 150 },
        ],
        rateGroups: [
          { rate: 10, net: 3500, vat: 350, gross: 3850 },
          { rate: 20, net: 750, vat: 150, gross: 900 },
        ],
      },
    });
    await runExtraction("f-rg-clean", fileData, { skipClassification: true });

    const doc = await fileDoc("f-rg-clean");
    expect(doc.extractedRateGroups).toEqual([
      { rate: 10, net: 3500, vat: 350, gross: 3850 },
      { rate: 20, net: 750, vat: 150, gross: 900 },
    ]);
    expect(doc.lineItemsUnreconciled).toBe(false);
    expect(doc.lineItemsUnreconciledRates).toBeNull();
    expect(doc.extractedAmount).toBe(4750);
    expect(doc.extractedVatAmount).toBe(500);
    expect(doc.extractedVatPercent).toBeNull(); // mixed 10% / 20%
  });

  it("localises a line-item failure to the damaged rate and keeps the block's VAT", async () => {
    const fileData = await seedFile("f-rg-noisy");
    q({
      extracted: {
        amount: 4750,
        vatPercent: 20,
        confidence: 0.7,
        lineItems: [
          { description: "Pasta", amount: 3850, vatPercent: 10, vatAmount: 350 },
          // 9,00 read as 90,00
          { description: "Wein", amount: 9000, vatPercent: 20, vatAmount: 150 },
        ],
        rateGroups: [
          { rate: 10, net: 3500, vat: 350, gross: 3850 },
          { rate: 20, net: 750, vat: 150, gross: 900 },
        ],
      },
    });
    await runExtraction("f-rg-noisy", fileData, { skipClassification: true });

    const doc = await fileDoc("f-rg-noisy");
    expect(doc.lineItemsUnreconciled).toBe(true);
    expect(doc.lineItemsUnreconciledRates).toEqual([20]);
    // the printed block is a second reading of the document, so it survives
    // the line-item failure and still carries the VAT
    expect(doc.extractedVatAmount).toBe(500);
    expect(doc.extractedAmount).toBe(4750);
    expect(doc.extractedLineItems).toHaveLength(2);
  });

  it("completes a block that prints only rate and gross", async () => {
    const fileData = await seedFile("f-rg-partial");
    q({
      extracted: {
        amount: 1200,
        confidence: 0.8,
        rateGroups: [{ rate: 20, gross: 1200 }],
      },
    });
    await runExtraction("f-rg-partial", fileData, { skipClassification: true });

    const doc = await fileDoc("f-rg-partial");
    // a missing COLUMN is arithmetic on printed numbers; a missing ROW is not
    expect(doc.extractedRateGroups).toEqual([{ rate: 20, net: 1000, vat: 200, gross: 1200 }]);
    expect(doc.extractedVatAmount).toBe(200);
    expect(doc.extractedVatPercent).toBe(20);
  });

  it("discards a block that does not sum to the document total", async () => {
    const fileData = await seedFile("f-rg-badsum");
    q({
      extracted: {
        amount: 9999,
        vatPercent: 20,
        confidence: 0.8,
        rateGroups: [{ rate: 20, net: 1000, vat: 200, gross: 1200 }],
      },
    });
    await runExtraction("f-rg-badsum", fileData, { skipClassification: true });

    const doc = await fileDoc("f-rg-badsum");
    expect(doc.extractedRateGroups).toBeNull();
    expect(doc.extractedVatAmount).toBeNull();
    expect(doc.extractedAmount).toBe(9999);
  });

  it("clears the block when the document turns out not to be an invoice", async () => {
    const fileData = await seedFile("f-rg-notinvoice");
    q({ isNotInvoice: true, notInvoiceReason: "Werbeprospekt" });
    q({
      extracted: {
        amount: 1200,
        confidence: 0.8,
        rateGroups: [{ rate: 20, net: 1000, vat: 200, gross: 1200 }],
      },
    });
    await runExtraction("f-rg-notinvoice", fileData, {});

    const doc = await fileDoc("f-rg-notinvoice");
    expect(doc.isNotInvoice).toBe(true);
    expect(doc.extractedRateGroups).toBeNull();
    expect(doc.lineItemsUnreconciledRates).toBeNull();
  });
});

// ===========================================================================
// runExtraction — the document's own designated payable amount (#206)
// ===========================================================================

describe("runExtraction: fixed fields for every VAT layout (#540)", () => {
  it("spreads a VAT printed only under the total across the rows (Needle Vinyl Bar)", async () => {
    const fileData = await seedFile("f-540-bar");
    q({
      extracted: {
        amount: 6750,
        documentVatAmount: 1125,
        confidence: 0.9,
        lineItems: [
          { description: "Mexican Sling", amount: 3100, vatPercent: null, vatAmount: null },
          { description: "Misty Wood", amount: 1550, vatPercent: null, vatAmount: null },
          { description: "San Cosme Mezcal 4cl", amount: 2100, vatPercent: null, vatAmount: null },
        ],
        issuer: { name: "Needle Vinyl Bar", vatId: "ATU71726304" },
      },
      additionalFields: [
        { key: "tableNumber", label: "Tisch", value: "5" },
        { key: "paymentMethod", label: "Zahlungsart", value: "cash" },
      ],
    });
    await runExtraction("f-540-bar", fileData, { skipClassification: true });

    const doc = await fileDoc("f-540-bar");
    const items = doc.extractedLineItems as Array<{ vatPercent: number; vatAmount: number }>;
    expect(items.map((item) => item.vatPercent)).toEqual([20, 20, 20]);
    expect(items.reduce((sum, item) => sum + item.vatAmount, 0)).toBe(1125);
    expect(doc.lineItemsUnreconciled).toBe(false);
    expect(doc.extractedVatAmount).toBe(1125);
    expect(doc.extractedVatPercent).toBe(20);
    expect(doc.extractedDocumentVatAmount).toBe(1125);
    expect(doc.extractedCountry).toBe("AT");
    // The table number has no key and never reaches the record.
    expect(doc.extractedAdditionalFields).toEqual([
      { key: "paymentMethod", label: "Zahlungsart", value: "cash", rawValue: "cash" },
    ]);
  });

  it("keeps a printed VAT total on a document with neither rows nor a block", async () => {
    const fileData = await seedFile("f-540-tax");
    q({ extracted: { amount: 11900, documentVatAmount: 1900, confidence: 0.9 } });
    await runExtraction("f-540-tax", fileData, { skipClassification: true });

    const doc = await fileDoc("f-540-tax");
    expect(doc.extractedVatAmount).toBe(1900);
    expect(doc.extractedVatPercent).toBe(19);
  });

  it("takes the per-rate block from an RKSV code that adds up to the total", async () => {
    const fileData = await seedFile("f-540-rksv");
    q({
      extracted: { amount: 1750, confidence: 0.9 },
      qrCodes: ["_R1-AT0_K1_42_2026-01-02T10:00:00_12,00_5,50_0,00_0,00_0,00_x_y_z_sig"],
    });
    await runExtraction("f-540-rksv", fileData, { skipClassification: true });

    const doc = await fileDoc("f-540-rksv");
    expect(doc.extractedRateGroups).toEqual([
      { rate: 20, net: 1000, vat: 200, gross: 1200 },
      { rate: 10, net: 500, vat: 50, gross: 550 },
    ]);
    expect(doc.extractedVatAmount).toBe(250);
    expect((doc.extractedQrCodes as Array<{ format: string }>)[0].format).toBe("rksv");
  });

  it("fills a missing IBAN and payable amount from a valid Payment Code", async () => {
    const fileData = await seedFile("f-540-epc");
    q({
      extracted: { amount: 12345, confidence: 0.9, issuer: { name: "Lieferant GmbH" } },
      qrCodes: ["BCD\n002\n1\nSCT\n\nLieferant GmbH\nAT611904300234573201\nEUR123.45\n"],
    });
    await runExtraction("f-540-epc", fileData, { skipClassification: true });

    const doc = await fileDoc("f-540-epc");
    expect(doc.extractedIban).toBe("AT611904300234573201");
    expect(doc.extractedPayableAmount).toBe(12345);
    expect((doc.extractedQrCodes as Array<{ format: string }>)[0].format).toBe("epc");
  });

  it("ignores an RKSV code that does not add up to the total", async () => {
    const fileData = await seedFile("f-540-rksv-bad");
    q({
      extracted: { amount: 1790, confidence: 0.9 },
      qrCodes: ["_R1-AT0_K1_42_2026-01-02T10:00:00_12,00_5,50_0,00_0,00_0,00_x_y_z_sig"],
    });
    await runExtraction("f-540-rksv-bad", fileData, { skipClassification: true });

    const doc = await fileDoc("f-540-rksv-bad");
    expect(doc.extractedRateGroups).toBeNull();
    expect(doc.extractedVatAmount).toBeNull();
  });

  // #166: Null and Besonders name no single rate; the printed VAT total decides.
  const rksv = (date: string, buckets: string, counter = "x") =>
    `_R1-AT0_K1_42_${date}T10:00:00_${buckets}_${counter}_y_z_sig`;

  it("reads a Besonders amount as 4.9 % when the printed VAT total says so, and records the source", async () => {
    const fileData = await seedFile("f-166-besonders");
    q({
      extracted: { amount: 2249, documentVatAmount: 249, confidence: 0.9 },
      qrCodes: [rksv("2026-07-15", "12,00_0,00_0,00_0,00_10,49")],
    });
    await runExtraction("f-166-besonders", fileData, { skipClassification: true });

    const doc = await fileDoc("f-166-besonders");
    expect(doc.extractedRateGroups).toEqual([
      { rate: 20, net: 1000, vat: 200, gross: 1200 },
      { rate: 4.9, net: 1000, vat: 49, gross: 1049 },
    ]);
    expect(doc.extractedVatAmount).toBe(249);
    expect(doc.extractedRateGroupsSource).toBe("rksvCode");
    expect(doc.needsRksvCodeReview).toBe(false);
  });

  it("reads a deposit in Null as 0 % only when the printed VAT total leaves no VAT for it", async () => {
    const fileData = await seedFile("f-166-pfand");
    q({
      extracted: { amount: 1275, documentVatAmount: 200, confidence: 0.9 },
      qrCodes: [rksv("2026-08-01", "12,00_0,00_0,00_0,75_0,00")],
    });
    await runExtraction("f-166-pfand", fileData, { skipClassification: true });

    const doc = await fileDoc("f-166-pfand");
    expect(doc.extractedRateGroups).toEqual([
      { rate: 20, net: 1000, vat: 200, gross: 1200 },
      { rate: 0, net: 75, vat: 0, gross: 75 },
    ]);
    expect(doc.extractedRateGroupsSource).toBe("rksvCode");
  });

  it("does not use a Besonders amount when no VAT total is printed", async () => {
    const fileData = await seedFile("f-166-no-vat");
    q({
      extracted: { amount: 2249, confidence: 0.9 },
      qrCodes: [rksv("2026-07-15", "12,00_0,00_0,00_0,00_10,49")],
    });
    await runExtraction("f-166-no-vat", fileData, { skipClassification: true });

    const doc = await fileDoc("f-166-no-vat");
    expect(doc.extractedRateGroups).toBeNull();
    expect(doc.extractedRateGroupsSource).toBeNull();
  });

  it("keeps a printed block the code contradicts and flags the File with the rates", async () => {
    const fileData = await seedFile("f-166-disagree");
    q({
      extracted: {
        amount: 2260,
        confidence: 0.9,
        // The model transposed the 10 % and 13 % rows.
        rateGroups: [
          { rate: 10, net: 1000, vat: 100, gross: 1100 },
          { rate: 13, net: 1027, vat: 133, gross: 1160 },
        ],
      },
      qrCodes: [rksv("2026-05-02", "0,00_11,60_11,00_0,00_0,00")],
    });
    await runExtraction("f-166-disagree", fileData, { skipClassification: true });

    const doc = await fileDoc("f-166-disagree");
    expect((doc.extractedRateGroups as Array<{ rate: number }>).map((g) => g.rate)).toEqual([10, 13]);
    expect(doc.extractedRateGroupsSource).toBe("document");
    expect(doc.needsRksvCodeReview).toBe(true);
    expect(doc.rksvCodeDisagreeingRates).toEqual([10, 13]);
  });

  it("does not flag a printed block the code agrees with, nor a partial cash payment", async () => {
    const agree = await seedFile("f-166-agree");
    q({
      extracted: { amount: 1200, confidence: 0.9, rateGroups: [{ rate: 20, net: 1000, vat: 200, gross: 1200 }] },
      qrCodes: [rksv("2026-05-02", "12,00_0,00_0,00_0,00_0,00")],
    });
    await runExtraction("f-166-agree", agree, { skipClassification: true });
    expect((await fileDoc("f-166-agree")).needsRksvCodeReview).toBe(false);

    const partial = await seedFile("f-166-partial");
    q({
      extracted: { amount: 2400, confidence: 0.9, rateGroups: [{ rate: 20, net: 2000, vat: 400, gross: 2400 }] },
      qrCodes: [rksv("2026-05-02", "12,00_0,00_0,00_0,00_0,00")],
    });
    await runExtraction("f-166-partial", partial, { skipClassification: true });
    expect((await fileDoc("f-166-partial")).needsRksvCodeReview).toBe(false);
  });

  it("marks a training receipt not an invoice, over the classifier's verdict", async () => {
    const fileData = await seedFile("f-166-training");
    q({ isInvoice: true, confidence: 0.95 });
    q({
      extracted: { amount: 1200, confidence: 0.9 },
      qrCodes: [rksv("2026-05-02", "12,00_0,00_0,00_0,00_0,00", "VFJB")],
    });
    await runExtraction("f-166-training", fileData, { skipClassification: false });

    const doc = await fileDoc("f-166-training");
    expect(doc.isNotInvoice).toBe(true);
    expect(doc.notInvoiceReason).toMatch(/training receipt/i);
    expect(doc.extractedRateGroups).toBeNull();
    expect(doc.extractedRateGroupsSource).toBeNull();
  });

  it("leaves a training receipt the user declared an invoice as an invoice", async () => {
    const fileData = await seedFile("f-166-training-override");
    q({
      extracted: { amount: 1200, confidence: 0.9 },
      qrCodes: [rksv("2026-05-02", "12,00_0,00_0,00_0,00_0,00", "VFJB")],
    });
    await runExtraction("f-166-training-override", fileData, { skipClassification: true });

    const doc = await fileDoc("f-166-training-override");
    expect(doc.isNotInvoice).toBe(false);
    expect(doc.extractedRateGroups).toBeNull();
  });

  it("keeps a cancellation receipt and takes nothing from its code", async () => {
    const fileData = await seedFile("f-166-storno");
    q({ isInvoice: true, confidence: 0.95 });
    q({
      extracted: { amount: 1200, confidence: 0.9 },
      qrCodes: [rksv("2026-05-02", "12,00_0,00_0,00_0,00_0,00", "U1RP")],
    });
    await runExtraction("f-166-storno", fileData, { skipClassification: false });

    const doc = await fileDoc("f-166-storno");
    expect(doc.isNotInvoice).toBe(false);
    expect(doc.extractedRateGroups).toBeNull();
    expect((doc.extractedQrCodes as Array<{ receiptKind?: string }>)[0].receiptKind).toBe("cancellation");
  });
});

describe("runExtraction: designated payable amount", () => {
  it("stores the demanded figure beside the document total, moving neither", async () => {
    // A Mahnung printing 750,00 (the original invoice) and 3.390,00 (what is
    // now demanded). Before #206 nothing on the record distinguished them and
    // the figure had to be set by hand.
    const fileData = await seedFile("f-pay-mahnung");
    q({
      extracted: {
        amount: 75000,
        payableAmount: 339000,
        vatPercent: 20,
        selfDesignation: "Mahnung",
        confidence: 0.8,
      },
    });
    await runExtraction("f-pay-mahnung", fileData, { skipClassification: true });

    const doc = await fileDoc("f-pay-mahnung");
    expect(doc.extractedPayableAmount).toBe(339000);
    // The pre-existing figure is untouched — the new field is a second
    // reading, not a correction of the first.
    expect(doc.extractedAmount).toBe(75000);
    expect(doc.extractedVatPercent).toBe(20);
  });

  it("records an absence when the document designates no figure as due", async () => {
    const fileData = await seedFile("f-pay-single");
    q({ extracted: { amount: 4200, vatPercent: 20, confidence: 0.9 } });
    await runExtraction("f-pay-single", fileData, { skipClassification: true });

    const doc = await fileDoc("f-pay-single");
    // Written, not omitted: "looked and found none" must be distinguishable
    // from a record written before the field existed.
    expect(doc.extractedPayableAmount).toBeNull();
    expect(doc.extractedAmount).toBe(4200);
  });

  it("clears the figure when the document turns out not to be an invoice", async () => {
    const fileData = await seedFile("f-pay-notinvoice");
    q({ isNotInvoice: true, notInvoiceReason: "Werbeprospekt" });
    q({ extracted: { amount: 4200, payableAmount: 4200, confidence: 0.8 } });
    await runExtraction("f-pay-notinvoice", fileData, {});

    const doc = await fileDoc("f-pay-notinvoice");
    expect(doc.isNotInvoice).toBe(true);
    expect(doc.extractedPayableAmount).toBeNull();
  });
});

// ===========================================================================
// retryFileExtraction — gating, reset semantics, error persistence
// ===========================================================================

describe("characterization: retryFileExtraction callable", () => {
  function call(data: unknown, uid: string = USER) {
    return retryFileExtraction.run({ data, auth: { uid } } as never);
  }

  /** Retry, then let the worker run what it queued. */
  async function retryAndRun(data: { fileId: string } & Record<string, unknown>) {
    const res = await call(data);
    expect(res).toEqual({ queued: true, fileId: data.fileId });
    await drainExtractionQueue();
  }

  it("rejects a missing fileId as invalid-argument", async () => {
    await expect(call({})).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("rejects an unknown file as not-found", async () => {
    await expect(call({ fileId: "nope" })).rejects.toMatchObject({ code: "not-found" });
  });

  // Behaviour change, fork #74: this callable used to fetch a file by bare id
  // and re-extract it without looking at request.auth or the file's userId.
  it("requires authentication", async () => {
    await seedFile("f-anon", { extractionError: "boom", extractionComplete: true });
    await expect(retryFileExtraction.run({ data: { fileId: "f-anon" } } as never)).rejects.toMatchObject({
      code: "unauthenticated",
    });
    expect(gemini.requests).toHaveLength(0);
  });

  it("refuses a file owned by another user", async () => {
    await seedFile("f-theirs", { extractionError: "boom", extractionComplete: true });
    await expect(call({ fileId: "f-theirs" }, "someone-else")).rejects.toMatchObject({
      code: "permission-denied",
    });
    expect(gemini.requests).toHaveLength(0);
    // The reset is not written either — a refused retry leaves the document alone.
    expect((await fileDoc("f-theirs")).extractionError).toBe("boom");
  });

  it("rejects a completed file only when isNotInvoice was never set", async () => {
    await seedFile("f-done", { extractionComplete: true });
    await expect(call({ fileId: "f-done" })).rejects.toMatchObject({
      code: "failed-precondition",
      message: "File has already been extracted successfully. Pass force to re-extract it anyway.",
    });
  });

  // #184: the marker has to survive the round trip through the shim's jsonb
  // column, and the refusal has to fire for the UI's click too — the retry
  // button always passes force, so force cannot be what protects a correction.
  it("refuses a hand-corrected file, naming the fields, even when forced", async () => {
    await seedFile("f-corrected", {
      extractionComplete: true,
      extractedVatPercent: 0,
      extractionCorrectedFields: { vatPercent: Timestamp.now(), amount: Timestamp.now() },
      extractionCorrectedAt: Timestamp.now(),
    });

    await expect(call({ fileId: "f-corrected", force: true })).rejects.toMatchObject({
      code: "failed-precondition",
      message: expect.stringContaining("(amount, vatPercent)"),
    });
    expect(gemini.requests).toHaveLength(0);
    expect((await fileDoc("f-corrected")).extractedVatPercent).toBe(0);
  });

  it("re-extracts a corrected file when the caller opts in per file", async () => {
    await seedFile("f-overwrite", {
      extractionComplete: true,
      extractionCorrectedFields: { amount: Timestamp.now() },
      extractionCorrectedAt: Timestamp.now(),
    });
    q({ isInvoice: true, confidence: 0.95 });
    q({ extracted: { amount: 42, confidence: 1 } });

    await retryAndRun({ fileId: "f-overwrite", force: true, overwriteCorrections: true });

    const doc = await fileDoc("f-overwrite");
    expect(doc.extractedAmount).toBe(42);
    // The marker survives the overwrite — the file stays on the exclusion list.
    expect(Object.keys(doc.extractionCorrectedFields as object)).toEqual(["amount"]);
  });

  it("force re-extracts a completed file the guard would refuse", async () => {
    await seedFile("f-forced", { extractionComplete: true });
    // force is not a user override, so classification still runs first.
    q({ isInvoice: true, confidence: 0.95 });
    q({ extracted: { amount: 42, confidence: 1 } });

    await retryAndRun({ fileId: "f-forced", force: true });
    expect((await fileDoc("f-forced")).extractedAmount).toBe(42);
  });

  it("QUIRK: a successfully extracted file with isNotInvoice=false can always be re-extracted", async () => {
    // characterization: preserves current behavior — extraction always writes
    // isNotInvoice:false on success, which makes `userMarkedAsInvoice` true on
    // any later retry, so the failed-precondition guard never fires for
    // successfully extracted files. The retry also skips classification.
    await seedFile("f-redo", {
      extractionComplete: true,
      isNotInvoice: false,
      partnerId: "p-auto",
      partnerMatchedBy: "auto",
      partnerMatchConfidence: 0.9,
      partnerType: "local",
    });
    q({ extracted: { amount: 100, confidence: 1 } });

    await retryAndRun({ fileId: "f-redo" });
    expect(gemini.requests).toHaveLength(1); // user override → classification skipped

    const doc = await fileDoc("f-redo");
    expect(doc.extractionComplete).toBe(true);
    expect(doc.extractedAmount).toBe(100);
    expect(doc.extractionConfidence).toBe(100);
    // auto partner match is cleared by the reset and matching flags re-armed
    expect(doc.partnerId).toBeNull();
    expect(doc.partnerMatchedBy).toBeNull();
    expect(doc.partnerMatchConfidence).toBeNull();
    expect(doc.partnerMatchComplete).toBe(false);
    expect(doc.partnerSuggestions).toEqual([]);
    expect(doc.transactionMatchComplete).toBe(false);
    expect(doc.transactionSuggestions).toEqual([]);
  });

  it("preserves manual partner assignments across a retry of a not-invoice file", async () => {
    await seedFile("f-manual", {
      extractionComplete: true,
      isNotInvoice: true,
      notInvoiceReason: "misclassified",
      partnerId: "p-manual",
      partnerMatchedBy: "manual",
    });
    q({ extracted: { amount: 250, confidence: 0.9 } });

    await retryAndRun({ fileId: "f-manual" });
    expect(gemini.requests).toHaveLength(1); // wasNotInvoice → user override, no classify

    const doc = await fileDoc("f-manual");
    expect(doc.partnerId).toBe("p-manual");
    expect(doc.partnerMatchedBy).toBe("manual");
    expect(doc.isNotInvoice).toBe(false);
    expect(doc.notInvoiceReason).toBeNull();
    expect(doc.extractedAmount).toBe(250);
  });

  it("persists a new extraction error on the doc; the caller reads it there (#603)", async () => {
    await seedFile("f-err", {
      extractionError: "previous boom",
      extractionComplete: true,
      storagePath: "missing/nope.pdf",
    });

    await retryAndRun({ fileId: "f-err" });
    expect(gemini.requests).toHaveLength(0); // failed at download, before any AI call

    const doc = await fileDoc("f-err");
    expect(doc.extractionComplete).toBe(true);
    expect(doc.extractionError).toBe("No such object: missing/nope.pdf");
  });
});

// ===========================================================================
// extractFileData triggers — guards and error persistence
// (registered lazily so earlier tests are not affected by trigger dispatch)
// ===========================================================================

describe("characterization: extractFileData triggers", () => {
  beforeAll(async () => {
    await import("../extraction/extractFileData");
  });

  it("skips already-processed, Fibuki-generated, and soft-deleted files", async () => {
    await seedFile("t-done", { extractionComplete: true });
    await seedFile("t-fibuki", { isFibukiGenerated: true });
    await seedFile("t-deleted", { deletedAt: Timestamp.now() });
    await drainTriggers();
    expect(await drainExtractionQueue()).toBe(0); // nothing was queued

    expect(gemini.requests).toHaveLength(0);
    expect((await fileDoc("t-fibuki")).extractionError).toBeUndefined();
    expect((await fileDoc("t-deleted")).extractionError).toBeUndefined();
  });

  it("runs extraction on newly created files (classification result lands on the doc)", async () => {
    q({ isInvoice: false, reason: "Spam", confidence: 0.8 });
    await seedFile("t-new");
    await drainTriggers();
    // The trigger only queued it: nothing is extracted yet.
    expect(gemini.requests).toHaveLength(0);
    expect((await fileDoc("t-new")).extractionStartedAt).toBeUndefined();
    await drainExtractionQueue();

    const doc = await fileDoc("t-new");
    expect(doc.extractionStartedAt).toBeInstanceOf(Timestamp); // "Analyzing" from the claim on
    expect(doc.classificationComplete).toBe(true);
    expect(doc.isNotInvoice).toBe(true);
    expect(doc.notInvoiceReason).toBe("Spam");
    expect(doc.extractedText).toBe("(classification only - not an invoice)");
  });

  it("persists extraction failures on the doc instead of crashing the trigger", async () => {
    await seedFile("t-broken", { storagePath: undefined });
    await drainTriggers();
    await drainExtractionQueue();

    const doc = await fileDoc("t-broken");
    expect(doc.extractionComplete).toBe(true);
    expect(doc.extractionError).toBe("No storage path found for file");
  });

  it("re-runs extraction when a file is undeleted and still needs it", async () => {
    await seedFile("t-undelete", { deletedAt: Timestamp.now() });
    await drainTriggers(); // created while deleted → skipped

    q({ isInvoice: false, reason: "Duplicate upload", confidence: 0.7 });
    await db.collection("files").doc("t-undelete").update({ deletedAt: null });
    await drainTriggers();
    await drainExtractionQueue();

    const doc = await fileDoc("t-undelete");
    expect(doc.isNotInvoice).toBe(true);
    expect(doc.notInvoiceReason).toBe("Duplicate upload");
    expect(doc.extractionConfidence).toBe(70);
  });
});
