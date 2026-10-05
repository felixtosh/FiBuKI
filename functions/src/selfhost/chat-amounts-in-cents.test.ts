/**
 * Every amount the chat model reads is integer cents (#616, Felix's review on
 * #663). The wrapped tools return MCP's records, which are in cents; the
 * chat-only tools that report a File's amount must say the same, or the
 * model reads 50 as fifty euros on one call and fifty cents on the next.
 *
 * One case per chat-only tool that reported euros: waitForFileExtraction,
 * searchLocalFiles, and connectFileToTransaction's validation refusal.
 */

process.env.FIBUKI_STORAGE = "memory";

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";

// searchLocalFiles asks the matcher for a ranking over HTTP; here the ranking
// is fixed, since only what the tool reports about each File is under test.
vi.mock("@/lib/api/firebase-callable", () => ({
  callFirebaseFunction: async (name: string) => {
    if (name === "findFileMatchesForTransaction") {
      return {
        matches: [{ fileId: "f-invoice", confidence: 92, matchSources: ["amount_exact", "partner"] }],
        totalCandidates: 1,
        rejectedFileIds: [],
      };
    }
    throw new Error(`unexpected callable ${name}`);
  },
  lookupCompany: async () => ({ name: "Probe GmbH" }),
  lookupByVatId: async () => ({ name: "Probe GmbH", isValid: false }),
}));

const USER = "cents-user";
const CONFIG = { configurable: { userId: USER, authHeader: `Bearer uid:${USER}` } };
const db = getFirestore();
const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));

interface AgentTool {
  name: string;
  invoke: (args: unknown, config?: unknown) => Promise<unknown>;
}
let tools: Map<string, AgentTool>;

beforeAll(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("offline", { status: 503 })));
  const mod = await import("@/lib/agent/tools");
  tools = new Map((mod.ALL_TOOLS as unknown as AgentTool[]).map((t) => [t.name, t]));
}, 120_000);

beforeEach(async () => {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
  const mine = { userId: USER, createdAt: Timestamp.now(), updatedAt: Timestamp.now() };
  await db.collection("transactions").doc("t-office").set({
    ...mine, sourceId: "s-1", date: day("2026-03-10"), amount: -12345, currency: "EUR",
    name: "OFFICE SUPPLIES GMBH", partner: "Office Supplies GmbH", fileIds: [], isComplete: false,
  });
  // 123.45 EUR, an incoming invoice: money out.
  await db.collection("files").doc("f-invoice").set({
    ...mine, fileName: "office.pdf", fileType: "application/pdf", extractionComplete: true,
    extractedAmount: 12345, extractedCurrency: "EUR", invoiceDirection: "incoming",
    extractedPartner: "Office Supplies GmbH", extractedDate: day("2026-03-09"),
    uploadedAt: Timestamp.now(), transactionIds: [],
  });
  // 9.00 EUR: far off the Transaction's amount, so a connect is refused.
  await db.collection("files").doc("f-coffee").set({
    ...mine, fileName: "coffee.jpg", fileType: "image/jpeg", extractionComplete: true,
    extractedAmount: 900, extractedCurrency: "EUR", invoiceDirection: "incoming",
    extractedPartner: "Office Supplies GmbH", extractedDate: day("2026-03-09"),
    uploadedAt: Timestamp.now(), transactionIds: [],
  });
});

function tool(name: string): AgentTool {
  const t = tools.get(name);
  if (!t) throw new Error(`no chat tool ${name}`);
  return t;
}

describe("chat-only tools report a File's amount in cents", () => {
  it("waitForFileExtraction: the document total in cents, unsigned as getFile has it", async () => {
    const res = (await tool("waitForFileExtraction").invoke({ fileId: "f-invoice", timeoutSeconds: 2 }, CONFIG)) as Record<
      string,
      unknown
    >;
    expect(res.success).toBe(true);
    expect(res.extractedAmount).toBe(12345);
    expect(res.invoiceDirection).toBe("incoming");
    expect(res.extractedAmountFormatted).toMatch(/^123,45\s€$/);
  });

  it("searchLocalFiles: each candidate's amount in cents, next to the Transaction's", async () => {
    const res = (await tool("searchLocalFiles").invoke({ transactionId: "t-office" }, CONFIG)) as {
      searchedTransaction: { amount: number };
      candidates: Array<{ fileId: string; extractedAmount?: number }>;
    };
    expect(res.searchedTransaction.amount).toBe(-12345);
    expect(res.candidates.map((c) => [c.fileId, c.extractedAmount])).toEqual([["f-invoice", 12345]]);
  });

  it("searchLocalFiles: the chat's Local Files card shows those cents as euros", async () => {
    const res = await tool("searchLocalFiles").invoke({ transactionId: "t-office" }, CONFIG);
    // The web app's React, not the backend's older copy the card would not match.
    const { createElement } = await import("@/node_modules/react");
    const { renderToStaticMarkup } = await import("@/node_modules/react-dom/server");
    const { LocalFilesResult } = await import("@/design-system/tool-results/local-files-result");
    const { TooltipProvider } = await import("@/components/ui/tooltip");
    const html = renderToStaticMarkup(
      createElement(TooltipProvider, null, createElement(LocalFilesResult, { result: res as never }))
    );
    expect((res as { amountsIn?: string }).amountsIn).toBe("cents");
    expect(html).toMatch(/123,45\s€/);
    expect(html).not.toMatch(/12\.345,00/);

    // A result saved in a conversation before #616 carries euros and no unit.
    const saved = { ...(res as Record<string, unknown>), amountsIn: undefined };
    (saved.candidates as Array<{ extractedAmount?: number }>)[0].extractedAmount = 123.45;
    const savedHtml = renderToStaticMarkup(
      createElement(TooltipProvider, null, createElement(LocalFilesResult, { result: saved as never }))
    );
    expect(savedHtml).toMatch(/123,45\s€/);
  });

  it("connectFileToTransaction: a refusal states both amounts in cents", async () => {
    const res = (await tool("connectFileToTransaction").invoke(
      { fileId: "f-coffee", transactionId: "t-office", confidence: 80 },
      CONFIG
    )) as Record<string, unknown>;
    expect(res.error).toBe("VALIDATION_FAILED");
    expect(res.extractedAmount).toBe(900);
    expect(res.transactionAmount).toBe(-12345);
    // Nothing was connected.
    expect((await db.collection("transactions").doc("t-office").get()).data()!.fileIds).toEqual([]);
  });
});
