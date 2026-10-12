import { describe, expect, it } from "vitest";
import type { AutomationHistoryEntry } from "../../types/transaction";
import { automationKindOf, summarizeAutomations } from "./automation-summary";

const at = (iso: string) => new Date(iso) as unknown as AutomationHistoryEntry["ranAt"];
const entry = (e: Partial<AutomationHistoryEntry> & Pick<AutomationHistoryEntry, "type">): AutomationHistoryEntry => ({
  status: "completed",
  ranAt: at("2026-10-01T10:00:00Z"),
  ...e,
});

describe("automationKindOf", () => {
  it("puts a person, a clicked suggestion, the agent and the pipeline's model calls apart", () => {
    expect(automationKindOf({ type: "partner_assigned", actor: "manual" })).toBe("manual");
    expect(automationKindOf({ type: "partner_assigned", actor: "suggestion" })).toBe("manual");
    expect(automationKindOf({ type: "file_connected", actor: "ai" })).toBe("magic");
    expect(automationKindOf({ type: "receipt_search", actor: "auto" })).toBe("llm");
    expect(automationKindOf({ type: "company_check", actor: "auto" })).toBe("llm");
    expect(automationKindOf({ type: "partner_suggested", actor: "auto" })).toBe("auto");
  });
});

describe("summarizeAutomations", () => {
  const log = [
    entry({ type: "partner_suggested", actor: "auto", ranAt: at("2026-10-01T09:00:00Z") }),
    entry({ type: "company_check", actor: "auto", ranAt: at("2026-10-01T09:01:00Z") }),
    entry({ type: "partner_assigned", actor: "auto", ranAt: at("2026-10-01T09:02:00Z") }),
    entry({ type: "partner_assigned", actor: "manual", ranAt: at("2026-10-01T09:05:00Z") }),
    entry({ type: "file_connected", actor: "ai" }),
  ];

  it("counts only the area's lines", () => {
    expect(summarizeAutomations(log, "partner", true).counts).toEqual({ auto: 2, llm: 1, magic: 0, manual: 1 });
    expect(summarizeAutomations(log, "connection", true).counts).toEqual({ auto: 0, llm: 0, magic: 1, manual: 0 });
  });

  it("marks the kind of the latest match", () => {
    expect(summarizeAutomations(log, "partner", true).matchedBy).toBe("manual");
    expect(summarizeAutomations(log, "connection", true).matchedBy).toBe("magic");
  });

  it("marks nothing when the item holds no match now", () => {
    expect(summarizeAutomations(log, "partner", false).matchedBy).toBeNull();
  });

  it("ignores a failed match", () => {
    const failed = [entry({ type: "partner_assigned", actor: "auto", status: "failed" })];
    expect(summarizeAutomations(failed, "partner", true).matchedBy).toBeNull();
  });
});
