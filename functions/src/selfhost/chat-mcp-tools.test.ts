/**
 * One implementation per tool (#616): every chat tool with an MCP twin is a
 * thin wrapper over the `runTool` callable, which runs the same handler MCP
 * uses. The chat sees what MCP sees.
 *
 * Each drift the two implementations had is a fixture here, run through the
 * chat tool as the User's session (the callable, in-process) and through
 * handleTool, and the two outputs must be identical (MCP's as the model
 * reads it: forTheModel only reformats):
 *   - listing Files leaves out Purged Files and non-invoices,
 *   - the amount filters take cents on both lists,
 *   - a Merged Partner says so and names its survivor (#264),
 *   - another User's File is "not found", not "not authorized",
 *   - marking a Transaction complete re-derives its Documentation State (#215),
 *   - a bank account is validated and its IBAN normalised,
 *   - rolling a Transaction back goes through a server rule.
 *
 * The guard at the end fails when a chat tool with an MCP twin touches the
 * database itself: the web container's admin database throws in this file.
 */

process.env.FIBUKI_STORAGE = "memory";
process.env.FIBUKI_PLAN = "full";

import { readFileSync } from "fs";
import path from "path";
import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";
import { deriveDocumentationState } from "../documents/documentationState";

type Callable = {
  __selfhostCallable: true;
  run: (req: { data: unknown; auth?: { uid: string; token: Record<string, unknown> } }) => Promise<unknown>;
};

const barrelPromise = import("../index");

// The chat reaches the backend over HTTP as the session's User. Here the
// callable runs in-process as whoever the auth header names, and a failure
// comes back the way the HTTP client reports it: status and JSON body.
vi.mock("@/lib/api/firebase-callable", () => ({
  callFirebaseFunction: async (name: string, data: unknown, authHeader?: string) => {
    const barrel = (await barrelPromise) as Record<string, unknown>;
    const fn = (barrel[name] ?? barrel[`${name}Callable`]) as Callable | undefined;
    if (!fn || !("__selfhostCallable" in fn)) throw new Error(`no callable ${name}`);
    const uid = (authHeader || "").replace(/^Bearer /, "").replace(/^uid:/, "");
    try {
      // A JSON round trip, as on the wire.
      const result = await fn.run({ data: JSON.parse(JSON.stringify(data)), auth: uid ? { uid, token: {} } : undefined });
      return JSON.parse(JSON.stringify(result ?? null));
    } catch (err) {
      const e = err as { message?: string; code?: string };
      throw new Error(
        `Firebase function ${name} failed: 400 - ${JSON.stringify({ error: { message: e?.message, status: e?.code } })}`
      );
    }
  },
  lookupCompany: async () => ({ name: "Probe GmbH" }),
  lookupByVatId: async () => ({ name: "Probe GmbH", isValid: false }),
}));

// The guard: a chat tool that reads or writes the database itself fails here.
vi.mock("@/lib/firebase/admin", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getAdminDb: () => {
    throw new Error("a chat tool touched the database directly");
  },
}));

const USER = "chat-parity-user";
const OTHER = "chat-parity-other";
const CONFIG = { configurable: { userId: USER, authHeader: `Bearer uid:${USER}` } };

interface AgentTool {
  name: string;
  schema: { parse: (v: unknown) => Record<string, unknown> };
  invoke: (args: unknown, config?: unknown) => Promise<unknown>;
}

let handleTool: (uid: string, name: string, args: Record<string, unknown>) => Promise<unknown>;
let tools: Map<string, AgentTool>;
let wrapped: Record<string, string>;
let wrappedTools: AgentTool[];
let forTheModel: (mcpName: string, result: unknown) => unknown;

const db = getFirestore();
const day = (iso: string) => Timestamp.fromDate(new Date(`${iso}T00:00:00Z`));

beforeAll(async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("offline", { status: 503 })));
  await barrelPromise;
  ({ handleTool } = await import("../tools/handlers"));
  const mod = await import("@/lib/agent/tools");
  tools = new Map((mod.ALL_TOOLS as unknown as AgentTool[]).map((t) => [t.name, t]));
  const twins = await import("@/lib/agent/tools/mcp-tools");
  wrapped = twins.MCP_TWINS as Record<string, string>;
  wrappedTools = twins.MCP_TOOLS as unknown as AgentTool[];
  forTheModel = twins.forTheModel;
}, 120_000);

async function seed() {
  await __whenShimIdle();
  await __resetFirestoreShim();
  __resetTriggerShim();
  const now = Timestamp.now();
  const mine = { userId: USER, createdAt: now, updatedAt: now };

  await db.collection("sources").doc("s-giro").set({ ...mine, name: "Giro", iban: "AT611904300234573201", currency: "EUR", type: "manual", isActive: true });
  await db.collection("sources").doc("s-old").set({ ...mine, name: "Old account", iban: null, currency: "EUR", type: "manual", isActive: false });

  await db.collection("transactions").doc("t-amazon").set({
    ...mine, sourceId: "s-giro", date: day("2026-03-10"), amount: -5000, currency: "EUR",
    name: "AMAZON MARKETPLACE", partnerId: "p-amazon", partnerType: "user", fileIds: ["f-amazon"], isComplete: true,
  });
  await db.collection("transactions").doc("t-client").set({
    ...mine, sourceId: "s-giro", date: day("2026-02-01"), amount: 120000, currency: "EUR",
    name: "Client GmbH", description: "January retainer", fileIds: [], isComplete: false,
  });
  await db.collection("transactions").doc("t-fee").set({
    ...mine, sourceId: "s-giro", date: day("2026-01-31"), amount: -1500, currency: "EUR",
    name: "Kontofuehrung", fileIds: [], noReceiptCategoryId: "c-fees", noReceiptCategoryTemplateId: "bank-fees", isComplete: true,
  });

  const file = { ...mine, fileType: "application/pdf", extractionComplete: true, uploadedAt: now };
  await db.collection("files").doc("f-amazon").set({
    ...file, fileName: "amazon.pdf", extractedAmount: 5000, extractedCurrency: "EUR", invoiceDirection: "incoming",
    extractedPartner: "Amazon EU", extractedDate: day("2026-03-09"), transactionIds: ["t-amazon"], partnerId: "p-amazon",
  });
  await db.collection("files").doc("f-coffee").set({
    ...file, fileName: "coffee.jpg", extractedAmount: 900, extractedCurrency: "EUR", invoiceDirection: "incoming",
    extractedPartner: "Cafe Central", extractedDate: day("2026-03-01"), transactionIds: [],
  });
  await db.collection("files").doc("f-purged").set({
    ...file, fileName: "purged.pdf", extractedAmount: 5000, deletedAt: now, purgedAt: now, transactionIds: [],
  });
  await db.collection("files").doc("f-flyer").set({
    ...file, fileName: "flyer.pdf", isNotInvoice: true, extractedAmount: 5000, transactionIds: [],
  });
  await db.collection("files").doc("f-theirs").set({
    ...file, userId: OTHER, fileName: "theirs.pdf", extractedAmount: 5000, transactionIds: [],
  });

  await db.collection("partners").doc("p-amazon").set({
    ...mine, name: "Amazon EU", aliases: ["AMZN"], vatId: "LU20260743", isActive: true,
  });
  await db.collection("partners").doc("p-amazon-old").set({
    ...mine, name: "Amazon EU S.a.r.l.", aliases: [], isActive: false, mergedInto: "p-amazon",
  });

  await db.collection("noReceiptCategories").doc("c-fees").set({
    ...mine, name: "Bank Fees", templateId: "bank-fees", isActive: true, matchedPartnerIds: [],
  });
}

function tool(name: string): AgentTool {
  const t = tools.get(name);
  if (!t) throw new Error(`no chat tool ${name}`);
  return t;
}

const wire = (v: unknown) => JSON.parse(JSON.stringify(v ?? null));

/**
 * The chat tool's answer and MCP's answer to the same arguments, the latter
 * as the model reads it (forTheModel: Timestamps as ISO strings, OCR text out
 * of list rows; the cases below pin that this is all it changes).
 */
async function both(chatName: string, args: Record<string, unknown>) {
  const t = tool(chatName);
  const parsed = t.schema.parse(args);
  const chat = await t.invoke(args, CONFIG);
  let mcp: unknown;
  try {
    mcp = forTheModel(wrapped[chatName], wire(await handleTool(USER, wrapped[chatName], parsed)));
  } catch (err) {
    mcp = { error: (err as Error).message };
  }
  // A list answer reaches the model as its JSON text (see runMcpTool).
  return { chat: typeof chat === "string" ? JSON.parse(chat) : wire(chat), mcp };
}

beforeEach(seed);

describe("chat tools with an MCP twin answer exactly what MCP answers", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["listSources", {}],
    ["listSources", { includeInactive: true }],
    ["getSource", { sourceId: "s-giro" }],
    ["listTransactions", {}],
    ["listTransactions", { search: "amazon", minAmount: 4000 }],
    ["listTransactions", { hasPartner: false, onlyExpenses: true }],
    ["listTransactions", { noReceiptCategoryTemplateId: "bank-fees" }],
    ["getTransaction", { transactionId: "t-amazon" }],
    ["listFiles", {}],
    ["listFiles", { search: "amazon" }],
    ["getFile", { fileId: "f-amazon" }],
    ["listPartners", { search: "amzn" }],
    ["getPartner", { partnerId: "p-amazon-old" }],
    ["listCategories", {}],
  ];

  for (const [name, args] of cases) {
    it(`${name}(${JSON.stringify(args)})`, async () => {
      const { chat, mcp } = await both(name, args);
      expect(chat).toEqual(mcp);
      expect(JSON.stringify(chat)).not.toContain("error");
    });
  }
});

describe("what reaches the model", () => {
  it("a list answer is its JSON text, so LangChain never reads records as content blocks", async () => {
    // A bank account record carries `type: "manual"`: an array of those would
    // otherwise be taken for message content blocks.
    const msg = (await tool("listSources").invoke(
      { type: "tool_call", id: "call-1", name: "listSources", args: {} },
      CONFIG
    )) as { content: unknown };
    expect(typeof msg.content).toBe("string");
    expect(JSON.parse(msg.content as string)[0]).toMatchObject({ id: "s-giro", type: "manual" });
  });
});

describe("the model reads MCP's records, reformatted only", () => {
  it("a Timestamp reads as an ISO date, not epoch seconds", async () => {
    const { chat } = await both("getFile", { fileId: "f-amazon" });
    expect(chat.extractedDate).toBe("2026-03-09T00:00:00.000Z");
    expect(typeof chat.uploadedAt).toBe("string");
    const raw = wire(await handleTool(USER, "get_file", { fileId: "f-amazon" }));
    expect(raw.extractedDate).toEqual({ _seconds: Date.UTC(2026, 2, 9) / 1000, _nanoseconds: 0 });
  });

  it("a Files list row leaves out the OCR text, and nothing else; getFile keeps it", async () => {
    await db.collection("files").doc("f-amazon").update({ extractedText: "Rechnung ".repeat(500) });
    const t = tool("listFiles");
    const chat = (await t.invoke({ search: "amazon" }, CONFIG)) as { files: Array<Record<string, unknown>> };
    const raw = wire(await handleTool(USER, "list_files", t.schema.parse({ search: "amazon" }))) as {
      files: Array<Record<string, unknown>>;
    };
    expect(raw.files[0].extractedText).toBeTruthy();
    expect(chat.files[0]).not.toHaveProperty("extractedText");
    expect(Object.keys(chat.files[0]).sort()).toEqual(
      Object.keys(raw.files[0]).filter((k) => k !== "extractedText").sort()
    );
    expect(chat.files.map((f) => f.id)).toEqual(raw.files.map((f) => f.id));

    const one = (await tool("getFile").invoke({ fileId: "f-amazon" }, CONFIG)) as Record<string, unknown>;
    expect(one.extractedText).toBe("Rechnung ".repeat(500));
  });

  it("a Transactions list row leaves out the import and automation bookkeeping, and nothing else; getTransaction keeps it", async () => {
    const bulky = {
      _original: { date: "10.03.2026", amount: "-50,00", rawRow: { Buchungstext: "AMAZON MARKETPLACE" } },
      automationHistory: [{ type: "partner_match", ranAt: Timestamp.now(), status: "completed", summary: "x".repeat(200) }],
      partnerSuggestions: [{ partnerId: "p-amazon", partnerType: "user", confidence: 90, source: "name" }],
      categorySuggestions: [{ categoryId: "c-fees", templateId: "bank-fees", confidence: 40 }],
      searchSuggestions: { suggestions: [{ query: "amazon", type: "company_name", score: 1 }], generatedAt: Timestamp.now() },
      aiSearchQueries: ["amazon invoice"],
      aiSearchQueriesForPartnerId: "p-amazon",
      reconciliationSuggestions: [{ bankTransactionId: "t-client", confidence: 10 }],
      rejectedFiles: [{ fileId: "f-coffee", rejectedAt: Timestamp.now() }],
      dedupeHash: "hash-amazon",
      csvRowIndex: 7,
    };
    const trimmed = Object.keys(bulky);
    await db.collection("transactions").doc("t-amazon").update({ ...bulky, rejectedFileIds: ["f-coffee"] });

    const t = tool("listTransactions");
    const args = t.schema.parse({});
    const chat = (await t.invoke({}, CONFIG)) as { transactions: Array<Record<string, unknown>>; total: number };
    const raw = forTheModel(
      "get_transaction",
      wire(await handleTool(USER, "list_transactions", args))
    ) as { transactions: Array<Record<string, unknown>>; total: number };

    // Rows, their order and the page's figures are unchanged.
    expect(chat.transactions.map((r) => r.id)).toEqual(raw.transactions.map((r) => r.id));
    expect(chat.total).toBe(raw.total);
    for (const [i, row] of chat.transactions.entries()) {
      const full = raw.transactions[i];
      for (const field of trimmed) expect(row, `${row.id}.${field}`).not.toHaveProperty(field);
      // Every other field is the MCP value as it stands.
      const kept = Object.fromEntries(Object.entries(full).filter(([k]) => !trimmed.includes(k)));
      expect(row).toEqual(kept);
    }
    const amazon = chat.transactions.find((r) => r.id === "t-amazon")!;
    expect(amazon).toMatchObject({
      date: "2026-03-10",
      amount: -5000,
      name: "AMAZON MARKETPLACE",
      partnerId: "p-amazon",
      fileIds: ["f-amazon"],
      rejectedFileIds: ["f-coffee"],
      isComplete: true,
    });

    const one = (await tool("getTransaction").invoke({ transactionId: "t-amazon" }, CONFIG)) as Record<string, unknown>;
    for (const field of trimmed) expect(one, field).toHaveProperty(field);
  });

  it("the chat's Files card shows a wrapper row's date, partner, amount and link", async () => {
    const { fileResultFromRecord } = await import("@/design-system/tool-results/file-result-from-record");
    const chat = (await tool("listFiles").invoke({ search: "amazon" }, CONFIG)) as { files: Array<Record<string, unknown>> };
    expect(fileResultFromRecord(chat.files[0])).toMatchObject({
      id: "f-amazon",
      fileName: "amazon.pdf",
      dateFormatted: "09.03.2026",
      partnerName: "Amazon EU",
      amount: -50,
      amountFormatted: expect.stringMatching(/^-50,00\s€$/),
      hasTransaction: true,
    });
  });
});

describe("the drifts, each a fixture", () => {
  it("listing Files leaves out Purged Files and non-invoices", async () => {
    const { chat, mcp } = await both("listFiles", { limit: 50 });
    expect(chat).toEqual(mcp);
    const ids = (chat.files as Array<{ id: string }>).map((f) => f.id).sort();
    expect(ids).toEqual(["f-amazon", "f-coffee"]);
  });

  it("the Files amount filter takes cents, as every MCP amount does", async () => {
    const atLeast = await both("listFiles", { minAmount: 4000 });
    expect(atLeast.chat).toEqual(atLeast.mcp);
    expect((atLeast.chat.files as Array<{ id: string }>).map((f) => f.id)).toEqual(["f-amazon"]);

    const atMost = await both("listFiles", { maxAmount: 1000 });
    expect(atMost.chat).toEqual(atMost.mcp);
    expect((atMost.chat.files as Array<{ id: string }>).map((f) => f.id)).toEqual(["f-coffee"]);
  });

  it("the Transactions amount filter takes cents and compares the absolute amount", async () => {
    const { chat, mcp } = await both("listTransactions", { maxAmount: 2000 });
    expect(chat).toEqual(mcp);
    expect((chat.transactions as Array<{ id: string }>).map((t) => t.id)).toEqual(["t-fee"]);
    expect(chat.total).toBe(1);
  });

  it("a Merged Partner says it was merged and names its survivor (#264)", async () => {
    const { chat, mcp } = await both("getPartner", { partnerId: "p-amazon-old" });
    expect(chat).toEqual(mcp);
    expect(chat.mergedInto).toBe("p-amazon");
    expect(chat.survivor).toEqual({ id: "p-amazon", name: "Amazon EU" });
  });

  it("another User's File is not found, the same answer as a File that does not exist", async () => {
    const theirs = await both("getFile", { fileId: "f-theirs" });
    const missing = await both("getFile", { fileId: "f-nowhere" });
    expect(theirs.chat).toEqual({ error: "File not found" });
    expect(theirs.mcp).toEqual({ error: "File not found" });
    expect(missing.chat).toEqual(theirs.chat);
    expect(JSON.stringify(theirs.chat)).not.toContain("authorized");
  });

  it("marking a Transaction complete re-derives its Documentation State (#215)", async () => {
    await db.collection("transactions").doc("t-client").update({ documentationState: "stale-marker" });
    const res = (await tool("updateTransaction").invoke(
      { transactionId: "t-client", isComplete: true, description: "Retainer, January" },
      CONFIG
    )) as Record<string, unknown>;
    expect(res.success).toBe(true);
    const stored = (await db.collection("transactions").doc("t-client").get()).data()!;
    expect(stored.isComplete).toBe(true);
    expect(stored.description).toBe("Retainer, January");
    expect(stored.documentationState).toEqual(deriveDocumentationState({ fileTypes: [], hasNoReceiptCategory: false }));
  });

  it("a bank account's name is validated and its IBAN normalised", async () => {
    const created = (await tool("createSource").invoke(
      { name: "Business", iban: " at61 1904 3002 3457 3201 ", currency: "EUR" },
      CONFIG
    )) as { success?: boolean; sourceId?: string };
    expect(created.success).toBe(true);
    const stored = (await db.collection("sources").doc(created.sourceId!).get()).data()!;
    expect(stored.iban).toBe("AT611904300234573201");
    expect(stored.userId).toBe(USER);

    const before = (await db.collection("sources").where("userId", "==", USER).get()).size;
    const refused = (await tool("createSource").invoke({ name: "   ", iban: "AT611904300234573201" }, CONFIG)) as {
      error?: string;
    };
    expect(refused.error).toMatch(/name is required/i);
    expect((await db.collection("sources").where("userId", "==", USER).get()).size).toBe(before);
  });
});

describe("rolling a Transaction back", () => {
  it("restores the values an edit replaced, through the update rules, and records the rollback", async () => {
    const edit = (await tool("updateTransaction").invoke(
      { transactionId: "t-client", description: "Wrong text", isComplete: true },
      CONFIG
    )) as { historyId?: string };
    expect(edit.historyId).toBeTruthy();

    const rolled = (await tool("rollbackTransaction").invoke(
      { transactionId: "t-client", historyId: edit.historyId },
      CONFIG
    )) as Record<string, unknown>;
    expect(rolled.success).toBe(true);
    expect(rolled.restoredValues).toEqual({ description: "January retainer", isComplete: false });

    const stored = (await db.collection("transactions").doc("t-client").get()).data()!;
    expect(stored.description).toBe("January retainer");
    expect(stored.isComplete).toBe(false);
    expect(stored.documentationState).toEqual(deriveDocumentationState({ fileTypes: [], hasNoReceiptCategory: false }));

    const history = await db.collection("transactions").doc("t-client").collection("history").get();
    const rollbackEntry = history.docs.map((d) => d.data()).find((h) => h.rollbackFrom === edit.historyId);
    expect(rollbackEntry?.newValues).toEqual({ description: "January retainer", isComplete: false });
  });

  it("refuses an entry naming a field an edit may not write", async () => {
    await db.doc("transactions/t-client/history/h-forged").set({
      changedAt: Timestamp.now(),
      changedBy: USER,
      previousValues: { amount: 1, userId: OTHER },
      newValues: { amount: 120000 },
    });
    const res = (await tool("rollbackTransaction").invoke({ transactionId: "t-client", historyId: "h-forged" }, CONFIG)) as {
      error?: string;
    };
    expect(res.error).toMatch(/amount/);
    const stored = (await db.collection("transactions").doc("t-client").get()).data()!;
    expect(stored.amount).toBe(120000);
    expect(stored.userId).toBe(USER);
  });

  it("finds neither another User's Transaction nor an entry that is not under the named Transaction", async () => {
    await db.collection("transactions").doc("t-theirs").set({
      userId: OTHER, date: day("2026-03-01"), amount: -100, name: "theirs", description: "theirs", fileIds: [],
    });
    await db.doc("transactions/t-theirs/history/h-theirs").set({
      changedAt: Timestamp.now(), changedBy: OTHER, previousValues: { description: "old" }, newValues: { description: "theirs" },
    });
    const theirs = (await tool("rollbackTransaction").invoke({ transactionId: "t-theirs", historyId: "h-theirs" }, CONFIG)) as {
      error?: string;
    };
    expect(theirs.error).toBe("Transaction not found");
    const crossed = (await tool("rollbackTransaction").invoke({ transactionId: "t-client", historyId: "h-theirs" }, CONFIG)) as {
      error?: string;
    };
    expect(crossed.error).toBe("History entry not found");
    expect((await db.collection("transactions").doc("t-theirs").get()).data()!.description).toBe("theirs");
  });
});

describe("guard: a chat tool with an MCP twin never touches the database itself", () => {
  /**
   * Chat tools whose name is an MCP tool's but which keep their own body:
   * each delegates its write to its own callable, and some still read a
   * record first. Wrapping them is not part of #616; this list only shrinks.
   */
  const NOT_YET_WRAPPED = new Set([
    "assignPartnerToFile",
    "assignPartnerToTransaction",
    "connectFileToTransaction",
    "createPartner",
    "dismissSplitSuggestion",
    "getCorrection",
    "getReceiptLink",
    "linkCorrection",
    "linkReceipt",
    "makeFileTheOriginal",
    "markFileAsCopy",
    "splitFile",
    "unlinkCorrection",
    "unlinkReceipt",
    "unmarkFileAsCopy",
    "updatePartner",
  ]);
  const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

  it("every chat tool named like an MCP tool is a wrapper or knowingly not yet one", async () => {
    const { TOOL_NAMES } = await import("../tools/definitions");
    const mcp = new Set(TOOL_NAMES);
    const unclassified = [...tools.keys()].filter(
      (n) => mcp.has(snake(n)) && !(n in wrapped) && !NOT_YET_WRAPPED.has(n)
    );
    expect(unclassified).toEqual([]);
    for (const n of NOT_YET_WRAPPED) expect(tools.has(n), `${n} no longer exists: drop it from the list`).toBe(true);
  });

  it("every twin in the agent's tool list is the wrapper, and names a real MCP tool", async () => {
    const { TOOL_NAMES } = await import("../tools/definitions");
    for (const [chatName, mcpName] of Object.entries(wrapped)) {
      expect(TOOL_NAMES).toContain(mcpName);
      expect(wrappedTools).toContain(tools.get(chatName));
    }
  });

  it("the wrappers' module reaches no database", () => {
    const src = readFileSync(path.resolve(__dirname, "../../../lib/agent/tools/mcp-tools.ts"), "utf8");
    expect(src).not.toMatch(/firebase\/admin|firebase-admin|getAdminDb|getDb\(|\.collection\(/);
  });

  it("the switch works: a chat-only read, which does use the database, fails in this file", async () => {
    await expect(
      tool("getTransactionHistory").invoke({ transactionId: "t-amazon" }, CONFIG)
    ).rejects.toThrow(/touched the database/);
  });

  it("every wrapper runs with the web container's database switched off", async () => {
    const own: Record<string, Record<string, unknown>> = {
      getSource: { sourceId: "s-giro" },
      getTransaction: { transactionId: "t-amazon" },
      getFile: { fileId: "f-amazon" },
      getPartner: { partnerId: "p-amazon" },
      updateTransaction: { transactionId: "t-client", description: "probe" },
      createSource: { name: "Probe", iban: "AT611904300234573201" },
    };
    for (const t of wrappedTools) {
      const res = JSON.stringify(await t.invoke(own[t.name] ?? {}, CONFIG));
      expect(res, t.name).not.toContain("touched the database");
      expect(res, t.name).not.toContain('"error"');
    }
  });
});
