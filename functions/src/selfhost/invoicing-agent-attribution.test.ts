/**
 * #156, end to end on the self-host shims: what a third-party-issuance
 * document leaves on the File, and what the Partner side does with it.
 *
 * The parser-level rules are pinned in
 * `extraction/__tests__/multi-party-attribution.test.ts`. What this file adds
 * is the two seams the ticket says the defect actually travels through:
 * `runExtraction` storing the Invoicing Agent under its own field name, and
 * the manual-correction path, which used to write the agent's name into the
 * aliases of the Partner a file was corrected to — the repair that spread the
 * defect further than the defect did.
 */

import { describe, it, expect, beforeEach, beforeAll, vi } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim } from "./firestore-shim";
import { drainTriggers, __resetTriggerShim } from "./trigger-shim";
import { getStorage } from "./storage-shim";

const gemini = vi.hoisted(() => ({ queue: [] as string[] }));

vi.mock("@google-cloud/vertexai", () => ({
  VertexAI: class {
    getGenerativeModel() {
      return {
        generateContent: async () => ({
          response: {
            candidates: [
              { content: { role: "model", parts: [{ text: gemini.queue.shift() ?? "{}" }] } },
            ],
            usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 },
          },
        }),
      };
    }
  },
}));

// REAL application code, unmodified:
import { runExtraction } from "../extraction/extractionCore";
import "../matching/matchFilePartner";

const db = getFirestore();
const USER = "stefan-test";
const STORAGE_PATH = "uploads/im-namen-von.pdf";

const AGENT = {
  name: "Agent Platform GmbH",
  vatId: "ATU87654321",
  address: "Agenturweg 9, 1030 Wien",
  iban: null,
  website: null,
};
const SUPPLIER = {
  name: "AL&FA Taxi KG",
  vatId: "ATU12345678",
  address: "Fahrweg 3, 1100 Wien",
  iban: null,
  website: null,
};

function q(response: Record<string, unknown> | string): void {
  gemini.queue.push(typeof response === "string" ? response : JSON.stringify(response));
}

async function seedFile(fileId: string, extra: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {
    userId: USER,
    storagePath: STORAGE_PATH,
    fileType: "application/pdf",
    fileName: "im-namen-von.pdf",
    extractionComplete: false,
    ...extra,
  };
  await db.collection("files").doc(fileId).set(data);
  return data;
}

async function fileDoc(fileId: string): Promise<Record<string, unknown>> {
  return (await db.collection("files").doc(fileId).get()).data()!;
}

beforeAll(() => {
  process.env.GCLOUD_PROJECT = "invoicing-agent-test-project";
  process.env.FIBUKI_STORAGE = "memory";
});

beforeEach(async () => {
  await new Promise((r) => setTimeout(r, 20));
  await __resetFirestoreShim();
  __resetTriggerShim();
  gemini.queue.length = 0;
  await getStorage().bucket().file(STORAGE_PATH).save(Buffer.from("fake-pdf-bytes"));
  // Passive mode: the deterministic path is what is under test, AI steps skip.
  await db.collection("subscriptions").doc(USER).set({
    userId: USER,
    automationMode: "passive",
    planId: "free",
  });
  await db.collection("users").doc(USER).collection("settings").doc("userData").set({
    companies: [{ name: "House of Bandits GmbH", vatId: "ATU99999999" }],
  });
});

describe("runExtraction: a document written im Namen von the supplier", () => {
  it("stores the agent under extractedInvoicingAgent and the supplier as the Partner", async () => {
    const fileData = await seedFile("f-agent");
    q({ isInvoice: true, confidence: 0.95 });
    q({
      rawText: "Rechnung ausgestellt von Agent Platform GmbH im Namen von: AL&FA Taxi KG",
      extracted: {
        date: "2026-07-01",
        amount: 2400,
        currency: "EUR",
        confidence: 0.9,
        issuer: { ...SUPPLIER },
        invoicingAgent: { ...AGENT },
        recipient: { name: "House of Bandits GmbH", vatId: "ATU99999999" },
      },
    });

    await runExtraction("f-agent", fileData, {});
    const doc = await fileDoc("f-agent");

    expect(doc.extractedInvoicingAgent).toEqual(AGENT);
    expect(doc.extractedIssuer).toEqual(SUPPLIER);
    expect(doc.invoiceDirection).toBe("incoming");
    // The Vorsteuer trail follows the Leistungserbringer (ADR-0003).
    expect(doc.extractedPartner).toBe(SUPPLIER.name);
    expect(doc.extractedVatId).toBe(SUPPLIER.vatId);
  });

  it("writes no Partner data at all when the agent was the only party read", async () => {
    const fileData = await seedFile("f-agent-only");
    q({ isInvoice: true, confidence: 0.95 });
    q({
      rawText: "Rechnung ausgestellt von Agent Platform GmbH im Namen von: AL&FA Taxi KG",
      extracted: {
        date: "2026-07-01",
        amount: 2400,
        currency: "EUR",
        confidence: 1,
        issuer: { ...AGENT },
        invoicingAgent: { ...AGENT },
        partner: AGENT.name,
        vatId: AGENT.vatId,
        recipient: { name: "House of Bandits GmbH", vatId: "ATU99999999" },
      },
    });

    await runExtraction("f-agent-only", fileData, {});
    const doc = await fileDoc("f-agent-only");

    expect(doc.extractedInvoicingAgent).toEqual(AGENT);
    expect(doc.extractedIssuer).toBeNull();
    expect(doc.extractedPartner ?? null).toBeNull();
    expect(doc.extractedVatId ?? null).toBeNull();
  });

  it("leaves a single-party document exactly as before, with no agent", async () => {
    const fileData = await seedFile("f-single");
    q({ isInvoice: true, confidence: 0.95 });
    q({
      rawText: "Rechnung Vendor GmbH",
      extracted: {
        date: "2026-07-01",
        amount: 12000,
        currency: "EUR",
        confidence: 0.9,
        issuer: { name: "Vendor GmbH", vatId: "DE123456789" },
        recipient: { name: "House of Bandits GmbH", vatId: "ATU99999999" },
      },
    });

    await runExtraction("f-single", fileData, {});
    const doc = await fileDoc("f-single");

    expect(doc.extractedInvoicingAgent).toBeNull();
    expect(doc.extractedPartner).toBe("Vendor GmbH");
    expect(doc.extractedVatId).toBe("DE123456789");
  });
});

describe("manual correction does not teach the agent's name as a supplier alias", () => {
  async function seedPartner(): Promise<void> {
    await db.collection("partners").doc("p-supplier").set({
      userId: USER,
      name: SUPPLIER.name,
      aliases: [],
      ibans: [],
      isActive: true,
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
  }

  async function correctByHand(fileId: string, extractedPartner: string): Promise<void> {
    await seedFile(fileId, {
      extractionComplete: true,
      partnerMatchComplete: true,
      partnerId: null,
      extractedPartner,
      extractedInvoicingAgent: { ...AGENT },
      transactionIds: [],
      createdAt: Timestamp.now(),
      updatedAt: Timestamp.now(),
    });
    await db.collection("files").doc(fileId).update({
      partnerId: "p-supplier",
      partnerType: "user",
      partnerMatchedBy: "manual",
      updatedAt: Timestamp.now(),
    });
    await drainTriggers();
    // The trigger learns the alias without awaiting it (fire-and-forget with a
    // .catch), so give that write a beat to land before reading it back.
    await new Promise((r) => setTimeout(r, 100));
  }

  async function aliases(): Promise<string[]> {
    const partner = (await db.collection("partners").doc("p-supplier").get()).data()!;
    return (partner.aliases as string[]) || [];
  }

  it("refuses the agent's name, however it reached extractedPartner", async () => {
    await seedPartner();
    // A File extracted before the agent had a field of its own: the agent is
    // what its extractedPartner holds, and correcting it is what used to put
    // the agent's name on four Partners in the reported corpus.
    await correctByHand("f-corrected", AGENT.name);
    expect(await aliases()).toEqual([]);
  });

  it("still learns a genuine variant of the supplier's own name", async () => {
    await seedPartner();
    await correctByHand("f-variant", "AL&FA Taxi KG (Wien)");
    expect(await aliases()).toEqual(["AL&FA Taxi KG (Wien)"]);
  });
});
