import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AutomationHistoryEntry } from "../../types/transaction";
import { automationMethodOf, summarizeAutomations } from "./automation-summary";

const at = (iso: string) => new Date(iso) as unknown as AutomationHistoryEntry["ranAt"];
const entry = (e: Partial<AutomationHistoryEntry> & Pick<AutomationHistoryEntry, "type">): AutomationHistoryEntry => ({
  status: "completed",
  ranAt: at("2026-10-01T10:00:00Z"),
  ...e,
});

const source = (file: string) => readFileSync(join(__dirname, "../../functions/src", file), "utf8");

describe("the summaries the ladder reads are still what the matchers write", () => {
  it.each([
    ["matching/matchFilePartner.ts", "its VAT ID"],
    ["matching/matchFilePartner.ts", "the EU VAT registry (VIES)"],
    ["matching/matchFilePartner.ts", "an AI company lookup"],
    ["matching/matchFilePartner.ts", "the name on the document"],
    ["matching/matchFilePartner.ts", "taken from the connected File"],
    ["matching/partnerProvenance.ts", "taken from the Files still connected"],
    ["partners/mergeUserPartners.ts", " merged into "],
    ["files/createFileRecord.ts", "found by the receipt search"],
  ])("%s writes %j", (file, phrase) => {
    expect(source(file)).toContain(phrase);
  });
});

describe("automationMethodOf", () => {
  const assigned = (summary: string, actor: AutomationHistoryEntry["actor"] = "auto") =>
    entry({ type: "partner_assigned", actor, summary });

  it("follows the File Partner steps", () => {
    expect(automationMethodOf(assigned('Partner "A" assigned by its VAT ID (95%)'), "filePartner")).toBe("vat");
    expect(automationMethodOf(assigned('Partner "A" assigned by the EU VAT registry (VIES)'), "filePartner")).toBe("vat");
    expect(automationMethodOf(assigned('Partner "A" assigned by partner matching (92%)'), "filePartner")).toBe("rules");
    expect(automationMethodOf(assigned('Partner "A" assigned by an AI company lookup', "ai"), "filePartner")).toBe("llm");
    expect(automationMethodOf(assigned('Partner "A" assigned by the name on the document (85%)'), "filePartner")).toBe("name");
    expect(automationMethodOf(assigned('Partner "A" assigned', "ai"), "filePartner")).toBe("magic");
    expect(automationMethodOf(assigned('Partner "A" assigned', "suggestion"), "filePartner")).toBe("manual");
  });

  it("follows the Transaction Partner steps", () => {
    expect(automationMethodOf(assigned('Partner "A" auto-assigned'), "transactionPartner")).toBe("rules");
    expect(automationMethodOf(assigned('Partner "A" taken from the connected File "x.pdf"'), "transactionPartner")).toBe("file");
    expect(automationMethodOf(entry({ type: "company_check", actor: "auto" }), "transactionPartner")).toBe("magic");
    expect(automationMethodOf(entry({ type: "partner_search", actor: "ai" }), "transactionPartner")).toBe("magic");
    expect(automationMethodOf(entry({ type: "partner_search", actor: "ai" }), "filePartner")).toBe("magic");
  });

  it("puts the receipt search and the AI with the agent on connections", () => {
    expect(automationMethodOf(entry({ type: "receipt_search", actor: "auto" }), "connection")).toBe("magic");
    expect(automationMethodOf(entry({ type: "transaction_search", actor: "ai" }), "connection")).toBe("magic");
    expect(automationMethodOf(entry({ type: "file_connected", actor: "ai" }), "connection")).toBe("magic");
    expect(automationMethodOf(entry({ type: "transaction_suggested", actor: "auto" }), "connection")).toBe("rules");
    expect(automationMethodOf(entry({ type: "file_connected", actor: "manual" }), "connection")).toBe("manual");
  });
});

describe("summarizeAutomations", () => {
  const log = [
    entry({ type: "partner_suggested", actor: "auto", summary: "suggested", ranAt: at("2026-10-01T09:00:00Z") }),
    entry({ type: "partner_assigned", actor: "auto", summary: 'Partner "A" assigned by its VAT ID', ranAt: at("2026-10-01T09:02:00Z") }),
    entry({ type: "file_connected", actor: "ai" }),
  ];

  it("lists the ladder's methods in escalation order and counts only the section's lines", () => {
    const s = summarizeAutomations(log, "filePartner", true);
    expect(s.methods).toEqual(["vat", "rules", "llm", "name", "magic", "manual"]);
    expect(s.counts).toEqual({ vat: 1, rules: 1, llm: 0, name: 0, magic: 0, manual: 0 });
    expect(summarizeAutomations(log, "connection", true).counts).toEqual({ rules: 0, magic: 1, manual: 0 });
  });

  it("marks the method of the latest match, and none without a match now", () => {
    expect(summarizeAutomations(log, "filePartner", true).matchedBy).toBe("vat");
    expect(summarizeAutomations(log, "connection", true).matchedBy).toBe("magic");
    expect(summarizeAutomations(log, "filePartner", false).matchedBy).toBeNull();
  });

  it("credits Magic when the agent created the Partner someone else then assigned", () => {
    const ikea = [
      entry({ type: "partner_assigned", actor: "auto", forPartnerId: "p1", summary: 'Partner "IKEA" assigned', ranAt: at("2026-10-01T09:01:00Z") }),
      entry({ type: "partner_search", actor: "ai", forPartnerId: "p1", summary: "Agent search: created Partner", ranAt: at("2026-10-01T09:02:00Z") }),
    ];
    const s = summarizeAutomations(ikea, "filePartner", true);
    expect(s.matchedBy).toBe("magic");
    expect(s.counts).toMatchObject({ rules: 1, magic: 1 });
  });

  it("keeps the finder's credit when a person confirms, and drops it when the Partner is removed", () => {
    const confirmed = [
      entry({ type: "partner_assigned", actor: "auto", forPartnerId: "p1", summary: 'Partner "A" assigned by its VAT ID', ranAt: at("2026-10-01T09:00:00Z") }),
      entry({ type: "partner_assigned", actor: "manual", forPartnerId: "p1", summary: 'Partner "A" confirmed', ranAt: at("2026-10-01T09:05:00Z") }),
    ];
    expect(summarizeAutomations(confirmed, "filePartner", true).matchedBy).toBe("vat");
    const reassigned = [
      ...confirmed,
      entry({ type: "partner_removed", actor: "manual", ranAt: at("2026-10-01T09:06:00Z") }),
      entry({ type: "partner_assigned", actor: "manual", forPartnerId: "p1", summary: 'Partner "A" assigned', ranAt: at("2026-10-01T09:07:00Z") }),
    ];
    expect(summarizeAutomations(reassigned, "filePartner", true).matchedBy).toBe("manual");
  });

  it("treats a merge as bookkeeping, not a match", () => {
    const merged = [
      entry({ type: "partner_assigned", actor: "auto", forPartnerId: "p1", summary: 'Partner "A" auto-assigned', ranAt: at("2026-10-01T09:00:00Z") }),
      entry({ type: "partner_assigned", actor: "manual", forPartnerId: "p2", summary: 'Partner "A" merged into "B"', ranAt: at("2026-10-01T09:05:00Z") }),
      entry({ type: "partner_assigned", actor: "manual", forPartnerId: "p2", summary: 'Partner "B" assigned', ranAt: at("2026-10-01T09:06:00Z") }),
    ];
    const s = summarizeAutomations(merged, "transactionPartner", true);
    expect(s.matchedBy).toBe("rules");
    expect(s.counts).toMatchObject({ rules: 1, manual: 1 });
  });

  it("credits Magic for a File the agent downloaded that the rules then connected", () => {
    const onTransaction = [
      entry({ type: "file_connected", actor: "auto", fileId: "f1", summary: 'File "x.pdf" auto-connected', ranAt: at("2026-10-01T09:01:00Z") }),
      entry({ type: "receipt_search", actor: "ai", fileId: "f1", summary: "Agent search: downloaded", ranAt: at("2026-10-01T09:02:00Z") }),
    ];
    expect(summarizeAutomations(onTransaction, "connection", true).matchedBy).toBe("magic");
    const onFile = [
      entry({ type: "file_created", actor: "auto", summary: "From Gmail, found by the receipt search for a Transaction" }),
      entry({ type: "transaction_connected", actor: "auto", summary: "Connected automatically" }),
    ];
    expect(summarizeAutomations(onFile, "connection", true).matchedBy).toBe("magic");
  });

  it("does not count a queue marker as a run", () => {
    const queued = [
      entry({ type: "receipt_search", actor: "auto", status: "pending", summary: "Receipt search queued" }),
      entry({ type: "company_check", actor: "auto", summary: "Queued partner search" }),
    ];
    expect(summarizeAutomations(queued, "connection", false).counts.magic).toBe(0);
    expect(summarizeAutomations(queued, "transactionPartner", false).counts.magic).toBe(0);
  });

  it("ignores a failed match", () => {
    const failed = [entry({ type: "partner_assigned", actor: "auto", status: "failed" })];
    expect(summarizeAutomations(failed, "filePartner", true).matchedBy).toBeNull();
  });
});
