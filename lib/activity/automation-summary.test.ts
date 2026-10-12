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
  });

  it("puts the receipt search and the AI with the agent on connections", () => {
    expect(automationMethodOf(entry({ type: "receipt_search", actor: "auto" }), "connection")).toBe("magic");
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

  it("ignores a failed match", () => {
    const failed = [entry({ type: "partner_assigned", actor: "auto", status: "failed" })];
    expect(summarizeAutomations(failed, "filePartner", true).matchedBy).toBeNull();
  });
});
