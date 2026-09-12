/**
 * #156: a document that prints more than one party block is attributed to the
 * wrong one.
 *
 * On third-party-issuance templates — an Invoicing Agent writing *im Namen von*
 * the supplier, as § 11 Abs 2 UStG permits — the agent came back as the issuer
 * with the footer UID, on all 15 files of one live corpus, at full confidence.
 * Where the supplier survived at all it landed in the free-form
 * additional-fields bag under a label the model invented per run (`Issuer
 * Platform` on one, `Service Provider` on the next).
 *
 * Pinned here: the prompt names which printed block is authoritative for each
 * field, the agent has a field of its own, and the two attributions that would
 * put the agent into a Vorsteuer trail are refused in code rather than asked
 * for — a prompt is a request, and this has to survive a model swap.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const gemini = vi.hoisted(() => ({
  queue: [] as string[],
  requests: [] as Array<{ contents: Array<{ parts: Array<Record<string, string>> }> }>,
}));

vi.mock("@google-cloud/vertexai", () => ({
  VertexAI: class {
    getGenerativeModel() {
      return {
        generateContent: async (req: unknown) => {
          gemini.requests.push(req as (typeof gemini.requests)[number]);
          return {
            response: {
              candidates: [
                { content: { role: "model", parts: [{ text: gemini.queue.shift() ?? "{}" }] } },
              ],
              usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1 },
            },
          };
        },
      };
    }
  },
}));

import { parseWithGemini, applyInvoicingAgentGuard } from "../geminiParser";
import { determineCounterparty } from "../../utils/identity-matcher";

// The template from the ticket: the agent writes for a licensed operator, its
// own UID is the one in the page footer, and the supplier's block sits under
// "im Namen von:".
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

/** The response the model gives when it reads the template correctly. */
function correctRun(): Record<string, unknown> {
  return {
    extracted: {
      amount: 2400,
      currency: "EUR",
      issuer: { ...SUPPLIER },
      invoicingAgent: { ...AGENT },
      recipient: { name: "House of Bandits GmbH", vatId: "ATU99999999" },
    },
  };
}

/** The response observed on the live corpus: the agent in the issuer slot. */
function agentAsIssuerRun(): Record<string, unknown> {
  return {
    extracted: {
      amount: 2400,
      currency: "EUR",
      issuer: { ...AGENT },
      invoicingAgent: { ...AGENT },
      partner: AGENT.name,
      vatId: AGENT.vatId,
      recipient: { name: "House of Bandits GmbH", vatId: "ATU99999999" },
    },
  };
}

function q(response: Record<string, unknown>): void {
  gemini.queue.push(JSON.stringify(response));
}

function promptText(): string {
  const parts = gemini.requests[gemini.requests.length - 1].contents[0].parts;
  return parts.map((p) => p.text ?? "").join("\n");
}

beforeEach(() => {
  process.env.GCLOUD_PROJECT = "multi-party-test-project";
  gemini.queue.length = 0;
  gemini.requests.length = 0;
});

describe("the extraction prompt names the authoritative printed block", () => {
  it("says which block the issuer, the agent and the recipient are read from", async () => {
    q(correctRun());
    await parseWithGemini(Buffer.from("x"), "application/pdf");
    const prompt = promptText();

    // Issuer: the supplier block, named by the construction that introduces it.
    expect(prompt).toContain("im Namen von");
    expect(prompt).toContain("§ 11 Abs 2 UStG");
    expect(prompt).toMatch(/NEVER take a\s+UID from the page footer/);
    // An absent supplier UID is an answer (the Kleinunternehmer case).
    expect(prompt).toContain("§ 6 Abs. 1 Z 27 UStG");

    // The agent has one name and is asked for nowhere else.
    expect(prompt).toContain('"invoicingAgent"');
    expect(prompt).toContain("Issuer Platform");
    expect(prompt).toContain("Service Provider");

    // Recipient: the billing block, by its printed heading — never the
    // delivery block, never a seller block.
    expect(prompt).toContain("Rechnungsadresse");
    expect(prompt).toContain("Lieferadresse");
    expect(prompt).toContain("Verkäufer");
    expect(prompt).toMatch(/return "recipient": null and lower\s+"confidence"/);
  });
});

describe("parseWithGemini: third-party issuance", () => {
  it("keeps the supplier as the issuer with the supplier's UID, and records the agent", async () => {
    q(correctRun());
    const res = await parseWithGemini(Buffer.from("x"), "application/pdf");

    expect(res.extracted.issuer).toEqual(SUPPLIER);
    expect(res.extracted.issuer?.vatId).toBe(SUPPLIER.vatId);
    expect(res.extracted.invoicingAgent).toEqual(AGENT);
    // The legacy flat fields feed extractedPartner, and they follow the issuer.
    expect(res.extracted.partner).toBe(SUPPLIER.name);
    expect(res.extracted.vatId).toBe(SUPPLIER.vatId);
  });

  it("refuses the footer UID on the supplier's own entity, and leaves it absent", async () => {
    // Two of the reported corpus are Kleinunternehmer: the supplier block
    // prints a name and an address, and the only UID on the page is the
    // agent's. Filling the gap from the footer would put the agent's UID in a
    // Vorsteuer trail on precisely the documents that carry no deductible VAT.
    q({
      extracted: {
        amount: 2400,
        issuer: { ...SUPPLIER, vatId: AGENT.vatId },
        invoicingAgent: { ...AGENT },
      },
    });
    const res = await parseWithGemini(Buffer.from("x"), "application/pdf");

    expect(res.extracted.issuer?.name).toBe(SUPPLIER.name);
    expect(res.extracted.issuer?.vatId).toBeNull();
    expect(res.extracted.vatId).toBeNull();
    expect(res.extracted.invoicingAgent?.vatId).toBe(AGENT.vatId);
  });

  it("refuses the agent returned as the issuer, rather than storing it as the supplier", async () => {
    q(agentAsIssuerRun());
    const res = await parseWithGemini(Buffer.from("x"), "application/pdf");

    expect(res.extracted.issuer).toBeNull();
    // ...and not through the flat fields either, which is the second route the
    // agent takes to extractedPartner.
    expect(res.extracted.partner).toBeNull();
    expect(res.extracted.vatId).toBeNull();
    expect(res.extractedRaw.partner).toBeNull();
    // The agent is kept — it explains the document, it just is not the Partner.
    expect(res.extracted.invoicingAgent).toEqual(AGENT);
  });

  it("reads two byte-identical layouts to the same issuer", async () => {
    q(correctRun());
    q(correctRun());
    const first = await parseWithGemini(Buffer.from("x"), "application/pdf");
    const second = await parseWithGemini(Buffer.from("x"), "application/pdf");
    expect(first.extracted.issuer).toEqual(second.extracted.issuer);

    // And when the model itself flips between the two readings of the same
    // layout, neither reading reports the agent as the supplier.
    q(correctRun());
    q(agentAsIssuerRun());
    const readA = await parseWithGemini(Buffer.from("x"), "application/pdf");
    const readB = await parseWithGemini(Buffer.from("x"), "application/pdf");
    for (const read of [readA, readB]) {
      expect(read.extracted.issuer?.name ?? null).not.toBe(AGENT.name);
      expect(read.extracted.partner).not.toBe(AGENT.name);
      expect(read.extracted.vatId).not.toBe(AGENT.vatId);
    }
  });

  it("drops an agent offered under an invented label in the additional-fields bag", async () => {
    q({
      extracted: { amount: 2400, issuer: { ...SUPPLIER }, invoicingAgent: { ...AGENT } },
      additionalFields: [
        { key: "issuerPlatform", label: "Issuer Platform", value: AGENT.name },
        { key: "serviceProvider", label: "Service Provider", value: AGENT.name },
        { key: "vatId", label: `${AGENT.name} UID`, value: AGENT.vatId },
        { key: "invoiceNumber", label: "Rechnungsnummer", value: "2024-0042" },
      ],
    });
    const res = await parseWithGemini(Buffer.from("x"), "application/pdf");

    expect(res.additionalFields).toEqual([
      { key: "invoiceNumber", label: "Rechnungsnummer", value: "2024-0042", rawValue: "2024-0042" },
    ]);
    expect(res.extracted.invoicingAgent).toEqual(AGENT);
  });
});

describe("parseWithGemini: single-party documents are unchanged", () => {
  it("leaves the issuer alone and reports no agent", async () => {
    q({
      extracted: {
        amount: 12000,
        issuer: { ...SUPPLIER },
        recipient: { name: "House of Bandits GmbH", vatId: "ATU99999999" },
      },
    });
    const res = await parseWithGemini(Buffer.from("x"), "application/pdf");

    expect(res.extracted.issuer).toEqual(SUPPLIER);
    expect(res.extracted.partner).toBe(SUPPLIER.name);
    expect(res.extracted.vatId).toBe(SUPPLIER.vatId);
    expect(res.extracted.invoicingAgent).toBeNull();
  });

  it("treats an agent with neither a name nor a UID as no agent at all", async () => {
    q({
      extracted: {
        amount: 12000,
        issuer: { ...SUPPLIER },
        invoicingAgent: { address: "Agenturweg 9" },
      },
    });
    const res = await parseWithGemini(Buffer.from("x"), "application/pdf");

    expect(res.extracted.invoicingAgent).toBeNull();
    expect(res.extracted.issuer).toEqual(SUPPLIER);
  });
});

describe("parseWithGemini: the recipient block", () => {
  it("keeps the billing addressee a marketplace document prints beside its other blocks", async () => {
    // Verkäufer, Rechnungsadresse, Lieferadresse and a seller contact on one
    // page: only the Rechnungsadresse is the addressee the recipient-identity
    // check has anything true to compare against.
    q({
      extracted: {
        amount: 4999,
        issuer: { name: "Marketplace Seller e.U.", vatId: "ATU11112222" },
        recipient: { name: "House of Bandits GmbH", address: "Kundenweg 5, 1010 Wien" },
        recipient_raw: { name: "House of Bandits GmbH", address: "Kundenweg 5\n1010 Wien" },
      },
    });
    const res = await parseWithGemini(Buffer.from("x"), "application/pdf");

    expect(res.extracted.recipient?.name).toBe("House of Bandits GmbH");
    expect(res.extracted.recipient?.address).toBe("Kundenweg 5, 1010 Wien");
    expect(res.extractedRaw.recipient?.name).toBe("House of Bandits GmbH");
  });

  it("refuses the agent transcribed into the recipient block", async () => {
    q({
      extracted: {
        amount: 2400,
        issuer: { ...SUPPLIER },
        recipient: { ...AGENT },
        recipient_raw: { name: AGENT.name },
        invoicingAgent: { ...AGENT },
      },
    });
    const res = await parseWithGemini(Buffer.from("x"), "application/pdf");

    expect(res.extracted.recipient).toBeNull();
    expect(res.extractedRaw.recipient).toBeNull();
  });
});

describe("applyInvoicingAgentGuard", () => {
  it("matches the agent across legal-form and punctuation noise, and nothing wider", () => {
    const printedAsShouted = { ...AGENT, name: "AGENT PLATFORM G.M.B.H." };
    expect(
      applyInvoicingAgentGuard(printedAsShouted, null, { ...AGENT, vatId: null }).issuer
    ).toBeNull();

    // A supplier whose name merely shares a word with the agent is a different
    // business, and refusing it would be the damage this guard exists to stop.
    const neighbour = { ...SUPPLIER, name: "Agent Platform Kurier KG" };
    expect(applyInvoicingAgentGuard(neighbour, null, AGENT).issuer).toEqual(neighbour);
  });

  it("reports what it refused, and leaves a document with no agent untouched", () => {
    expect(applyInvoicingAgentGuard(SUPPLIER, null, null)).toEqual({
      issuer: SUPPLIER,
      recipient: null,
      invoicingAgent: null,
      refusals: [],
    });
    expect(applyInvoicingAgentGuard(AGENT, AGENT, AGENT).refusals).toEqual(["issuer", "recipient"]);
    expect(
      applyInvoicingAgentGuard({ ...SUPPLIER, vatId: AGENT.vatId }, null, AGENT).refusals
    ).toEqual(["issuerVatId"]);
  });
});

describe("the Invoicing Agent is never a Partner (ADR-0003)", () => {
  it("is not a counterparty candidate: the supplier is", async () => {
    q(correctRun());
    const res = await parseWithGemini(Buffer.from("x"), "application/pdf");

    const userData = {
      companies: [{ name: "House of Bandits GmbH", vatId: "ATU99999999" }],
    };
    const result = determineCounterparty(
      res.extracted.issuer,
      res.extracted.recipient,
      userData,
      []
    );

    expect(result.invoiceDirection).toBe("incoming");
    expect(result.counterparty?.name).toBe(SUPPLIER.name);
    expect(result.counterparty?.vatId).toBe(SUPPLIER.vatId);
    // The agent is read off the same document and reaches none of this.
    expect(result.counterparty?.name).not.toBe(AGENT.name);
  });

  it("leaves nothing for a Partner match to find when the agent was the only party read", async () => {
    q(agentAsIssuerRun());
    const res = await parseWithGemini(Buffer.from("x"), "application/pdf");

    // Every field runPartnerMatching matches on, empty — a File with no
    // Partner takes one from a correction; a File carrying the agent as its
    // Partner teaches the agent's name as an alias and spreads.
    expect(res.extracted.partner).toBeNull();
    expect(res.extracted.vatId).toBeNull();
    expect(res.extracted.iban).toBeNull();
    expect(res.extracted.website).toBeNull();
  });
});
