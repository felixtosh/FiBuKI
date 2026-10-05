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
 * The writes that record who made them (#665: assigning a Partner to a
 * Transaction or a File, connecting a File, editing a Partner) run the shared
 * tool as the chat agent: runTool sets that caller, so the chat's answer is
 * handleTool's with the agent caller, and the stored provenance is the
 * agent's (`ai`, Connection Origin `agent`) where MCP's stays its own.
 *
 * The guard at the end fails when a chat tool with an MCP twin touches the
 * database itself: the web container's admin database throws in this file.
 */

process.env.FIBUKI_STORAGE = "memory";
process.env.FIBUKI_PLAN = "full";

import { readFileSync } from "fs";
import path from "path";
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { getFirestore, Timestamp, __resetFirestoreShim, __whenShimIdle } from "./firestore-shim";
import { __resetTriggerShim } from "./trigger-shim";
import { deriveDocumentationState } from "../documents/documentationState";
import { AGENT_WORKER_TYPES, agentCaller, type ToolCaller } from "../tools/caller";

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

let handleTool: (uid: string, name: string, args: Record<string, unknown>, caller?: ToolCaller) => Promise<unknown>;
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

// ============================================================================
// The writes that record who made them (#665)
// ============================================================================

const AGENT = agentCaller(null);

/** A reply without the record's write times: each run reseeds, so two runs cannot share them. */
function stable(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value).filter(([k]) => k !== "updatedAt" && k !== "createdAt"));
}

/** A Partner the User once removed from t-client: the agent may not put it back. */
async function seedRemovedPartner() {
  await db.collection("partners").doc("p-client").set({
    userId: USER, name: "Client GmbH", aliases: [], isActive: true,
    createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
    manualRemovals: [{ transactionId: "t-client", removedAt: Timestamp.now() }],
  });
}

/** A File that fits t-client: same amount, same name, a day apart. */
async function seedClientInvoice(extra: Record<string, unknown> = {}) {
  await db.collection("files").doc("f-client").set({
    userId: USER, fileName: "client.pdf", fileType: "application/pdf", extractionComplete: true,
    extractedAmount: 120000, extractedCurrency: "EUR", invoiceDirection: "outgoing",
    extractedPartner: "Client GmbH", extractedDate: day("2026-01-31"), uploadedAt: Timestamp.now(),
    transactionIds: [], sourceType: "gmail", gmailIntegrationId: "mail-1", gmailSenderEmail: "billing@client.example",
    createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
    ...extra,
  });
}

const viesXml = (valid: boolean, name = "") =>
  `<soap:Envelope><soap:Body><checkVatResponse><countryCode>AT</countryCode><vatNumber>U12345678</vatNumber>` +
  `<valid>${valid}</valid><name>${name || "---"}</name><address>---</address></checkVatResponse></soap:Body></soap:Envelope>`;

/** VIES answers with this XML (or is down, for null); every other fetch stays offline. */
function viesAnswers(xml: string | null) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { body?: unknown }) => {
      if (String(url).includes("ec.europa.eu")) {
        calls.push(String(init?.body ?? ""));
        return xml === null ? new Response("down", { status: 503 }) : new Response(xml, { status: 200 });
      }
      return new Response("offline", { status: 503 });
    })
  );
  return calls;
}

describe("the four writes: the chat answers what the shared tool answers as the agent (#665)", () => {
  afterEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("offline", { status: 503 })));
  });

  const cases: Array<[string, Record<string, unknown>]> = [
    ["assignPartnerToTransaction", { transactionId: "t-client", partnerId: "p-amazon" }],
    ["assignPartnerToFile", { fileId: "f-coffee", partnerId: "p-amazon" }],
    ["updatePartner", { partnerId: "p-amazon", website: "https://amazon.example", vatId: "ATU12345678" }],
    ["connectFileToTransaction", { fileId: "f-client", transactionId: "t-client", confidence: 91, searchQuery: "client" }],
  ];

  for (const [name, args] of cases) {
    it(`${name}(${JSON.stringify(args)})`, async () => {
      viesAnswers(viesXml(true, "AMAZON EU SARL"));
      await seedClientInvoice();
      const t = tool(name);
      const chat = wire(await t.invoke(args, CONFIG));
      expect((chat as { error?: unknown }).error).toBeUndefined();

      await seed();
      await seedClientInvoice();
      const agent = forTheModel(wrapped[name], wire(await handleTool(USER, wrapped[name], t.schema.parse(args), AGENT)));
      expect(stable(chat)).toEqual(stable(agent));
    });
  }

  it("the Partner writes answer MCP in MCP's shape, the agent's connect in the chat's", async () => {
    viesAnswers(viesXml(true, "AMAZON EU SARL"));
    await seedClientInvoice();
    for (const [name, args] of cases) {
      const t = tool(name);
      const chat = wire(await t.invoke(args, CONFIG)) as Record<string, unknown>;
      await seed();
      await seedClientInvoice();
      const mcp = wire(await handleTool(USER, wrapped[name], t.schema.parse(args))) as Record<string, unknown>;
      await seed();
      await seedClientInvoice();
      if (name === "connectFileToTransaction") {
        // MCP's connect reply is unchanged; the agent's keeps the chat's.
        expect(mcp).toEqual({ success: true, fileId: "f-client", transactionId: "t-client" });
        expect(chat).toEqual({
          success: true,
          connectionId: "f-client__t-client",
          alreadyConnected: false,
          fileName: "client.pdf",
          message: 'Connected "client.pdf" to transaction.',
        });
      } else {
        expect(Object.keys(chat).sort(), name).toEqual(Object.keys(mcp).sort());
      }
    }
  });
});

describe("assigning a Partner to a Transaction: one write, the caller's provenance (#665)", () => {
  it("the chat records ai, learned from and shown in the re-match review; MCP records api", async () => {
    const chat = (await tool("assignPartnerToTransaction").invoke(
      { transactionId: "t-client", partnerId: "p-amazon" },
      CONFIG
    )) as Record<string, unknown>;
    expect(chat).toEqual({ success: true, transactionId: "t-client", partnerId: "p-amazon" });
    const byChat = (await db.collection("transactions").doc("t-client").get()).data()!;
    expect(byChat.partnerMatchedBy).toBe("ai");
    expect(byChat.partnerType).toBe("user");
    const chatEntry = (byChat.automationHistory as Array<Record<string, unknown>>).at(-1)!;
    expect(chatEntry).toMatchObject({ type: "partner_assigned", actor: "ai", level: "outcome", forPartnerId: "p-amazon" });

    await seed();
    const mcp = await handleTool(USER, "assign_partner_to_transaction", { transactionId: "t-client", partnerId: "p-amazon" });
    expect(mcp).toEqual(chat);
    const byMcp = (await db.collection("transactions").doc("t-client").get()).data()!;
    expect(byMcp.partnerMatchedBy).toBe("api");
    const mcpEntry = (byMcp.automationHistory as Array<Record<string, unknown>>).at(-1)!;
    expect(mcpEntry).toMatchObject({ type: "partner_assigned", actor: "manual", level: "decision" });
    expect(mcpEntry.summary).toBe('Partner "Amazon EU" assigned via API');
  });

  it("the chat keeps the refusal of a Partner the User removed; MCP assigns it and leaves the removal standing", async () => {
    await seedRemovedPartner();
    const chat = (await tool("assignPartnerToTransaction").invoke(
      { transactionId: "t-client", partnerId: "p-client" },
      CONFIG
    )) as { error?: string };
    expect(chat.error).toMatch(/previously rejected for this transaction/);
    expect((await db.collection("transactions").doc("t-client").get()).data()!.partnerId).toBeUndefined();

    const mcp = (await handleTool(USER, "assign_partner_to_transaction", {
      transactionId: "t-client",
      partnerId: "p-client",
    })) as { success?: boolean };
    expect(mcp.success).toBe(true);
    expect((await db.collection("transactions").doc("t-client").get()).data()!.partnerId).toBe("p-client");
    const partner = (await db.collection("partners").doc("p-client").get()).data()!;
    expect(partner.manualRemovals).toHaveLength(1);
  });

  it("both refuse a Merged Partner, naming its survivor", async () => {
    const chat = (await tool("assignPartnerToTransaction").invoke(
      { transactionId: "t-client", partnerId: "p-amazon-old" },
      CONFIG
    )) as { error?: string };
    expect(chat.error).toMatch(/Merged Partner .*use p-amazon instead/);
    await expect(
      handleTool(USER, "assign_partner_to_transaction", { transactionId: "t-client", partnerId: "p-amazon-old" })
    ).rejects.toThrow(chat.error!);
    expect((await db.collection("transactions").doc("t-client").get()).data()!.partnerId).toBeUndefined();
  });

  it("the callable refuses the tool surface's own value", async () => {
    const barrel = (await barrelPromise) as Record<string, Callable>;
    await expect(
      barrel.assignPartnerToTransaction.run({
        data: { transactionId: "t-client", partnerId: "p-amazon", partnerType: "user", matchedBy: "api" },
        auth: { uid: USER, token: {} },
      })
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });
});

describe("assigning a Partner to a File: the caller's provenance (#665)", () => {
  it("the chat records ai and leaves the removal list and confidence; MCP records a person's assignment", async () => {
    await db.collection("files").doc("f-coffee").update({ partnerMatchConfidence: 40 });
    await db.collection("partners").doc("p-amazon").update({
      manualFileRemovals: [{ fileId: "f-coffee", removedAt: Timestamp.now() }],
    });

    const chat = (await tool("assignPartnerToFile").invoke({ fileId: "f-coffee", partnerId: "p-amazon" }, CONFIG)) as Record<
      string,
      unknown
    >;
    expect(chat).toEqual({ success: true, fileId: "f-coffee", partnerId: "p-amazon", partnerName: "Amazon EU", previousPartnerId: null });
    const byChat = (await db.collection("files").doc("f-coffee").get()).data()!;
    expect(byChat).toMatchObject({ partnerId: "p-amazon", partnerType: "user", partnerMatchedBy: "ai", partnerMatchConfidence: 40 });
    expect((await db.collection("partners").doc("p-amazon").get()).data()!.manualFileRemovals).toHaveLength(1);

    await seed();
    await db.collection("partners").doc("p-amazon").update({
      manualFileRemovals: [{ fileId: "f-coffee", removedAt: Timestamp.now() }],
    });
    await handleTool(USER, "assign_partner_to_file", { fileId: "f-coffee", partnerId: "p-amazon" });
    const byMcp = (await db.collection("files").doc("f-coffee").get()).data()!;
    expect(byMcp).toMatchObject({ partnerMatchedBy: "manual", partnerMatchConfidence: 100 });
    expect((await db.collection("partners").doc("p-amazon").get()).data()!.manualFileRemovals).toEqual([]);
  });

  it("both refuse a Merged Partner", async () => {
    const chat = (await tool("assignPartnerToFile").invoke({ fileId: "f-coffee", partnerId: "p-amazon-old" }, CONFIG)) as {
      error?: string;
    };
    expect(chat.error).toMatch(/Merged Partner/);
    expect((await db.collection("files").doc("f-coffee").get()).data()!.partnerId).toBeUndefined();
  });
});

describe("connecting a File: the agent's checks, the agent's only (#665)", () => {
  const connection = async () => (await db.collection("fileConnections").doc("f-client__t-client").get()).data();

  it("the chat connects with origin agent, its confidence and how the File was found; MCP with origin mcp", async () => {
    await seedClientInvoice();
    await tool("connectFileToTransaction").invoke(
      { fileId: "f-client", transactionId: "t-client", confidence: 91, searchQuery: "client invoice" },
      CONFIG
    );
    const byChat = (await connection())!;
    expect(byChat).toMatchObject({
      origin: "agent",
      connectionType: "manual",
      matchConfidence: 91,
      sourceType: "gmail_attachment",
      searchPattern: "client invoice",
      gmailIntegrationId: "mail-1",
      gmailMessageFrom: "billing@client.example",
      resultType: "gmail_attachment",
    });

    await seed();
    await seedClientInvoice();
    await handleTool(USER, "connect_file_to_transaction", { fileId: "f-client", transactionId: "t-client", confidence: 91 });
    const byMcp = (await connection())!;
    expect(byMcp).toMatchObject({ origin: "mcp", connectionType: "api" });
    expect(byMcp.matchConfidence ?? null).toBeNull();
    expect(byMcp.searchPattern).toBeUndefined();
  });

  it("the chat refuses a rejected pair unless a human asked; MCP has no override argument", async () => {
    await seedClientInvoice({ dismissedTransactionIds: ["t-client"] });
    const refused = (await tool("connectFileToTransaction").invoke(
      { fileId: "f-client", transactionId: "t-client", skipValidation: true },
      CONFIG
    )) as Record<string, unknown>;
    expect(refused.error).toBe("PAIR_REJECTED");
    expect(String(refused.message)).toContain("overrideDismissal=true");
    expect(await connection()).toBeUndefined();

    // MCP: an argument named like the agent's override is just an argument.
    await expect(
      handleTool(USER, "connect_file_to_transaction", { fileId: "f-client", transactionId: "t-client", overrideDismissal: true })
    ).rejects.toThrow(/PAIR_REJECTED/);
    expect(await connection()).toBeUndefined();

    const lifted = (await tool("connectFileToTransaction").invoke(
      { fileId: "f-client", transactionId: "t-client", overrideDismissal: true },
      CONFIG
    )) as Record<string, unknown>;
    expect(lifted.success).toBe(true);
    expect((await connection())!.origin).toBe("agent");
  });

  it("the rejection gate (fork #101): either stored shape, not lifted by skipValidation in a worker, gone once un-rejected", async () => {
    const batch = { configurable: { ...CONFIG.configurable, workerType: "partner_file_batch" } };
    await seedClientInvoice({ dismissedTransactions: [{ transactionId: "t-client", dismissedAt: Timestamp.now() }] });
    const refused = (await tool("connectFileToTransaction").invoke(
      { fileId: "f-client", transactionId: "t-client", skipValidation: true },
      batch
    )) as Record<string, unknown>;
    expect(refused.error).toBe("PAIR_REJECTED");
    expect(await connection()).toBeUndefined();

    await seed();
    await seedClientInvoice({
      dismissedTransactionIds: [],
      dismissedTransactions: [{ transactionId: "t-client", dismissedAt: Timestamp.now(), undismissedAt: Timestamp.now() }],
    });
    const connected = (await tool("connectFileToTransaction").invoke(
      { fileId: "f-client", transactionId: "t-client", skipValidation: true },
      batch
    )) as Record<string, unknown>;
    expect(connected.success).toBe(true);
  });

  it("the chat checks amount and Partner first; skipValidation lifts it, except for the receipt search worker", async () => {
    // 9 EUR for a 1,200 EUR Transaction.
    const refused = (await tool("connectFileToTransaction").invoke({ fileId: "f-coffee", transactionId: "t-client" }, CONFIG)) as Record<
      string,
      unknown
    >;
    expect(refused).toMatchObject({ error: "VALIDATION_FAILED", extractedAmount: 900, transactionAmount: 120000 });
    expect(String(refused.message)).toContain("skipValidation=true");

    const receiptSearch = { configurable: { ...CONFIG.configurable, workerType: "receipt_search" } };
    const strict = (await tool("connectFileToTransaction").invoke(
      { fileId: "f-coffee", transactionId: "t-client", skipValidation: true },
      receiptSearch
    )) as Record<string, unknown>;
    expect(strict.error).toBe("VALIDATION_FAILED");
    expect(String(strict.message)).toContain("receipt_search mode");
    expect((await db.collection("fileConnections").where("fileId", "==", "f-coffee").get()).size).toBe(0);

    const forced = (await tool("connectFileToTransaction").invoke(
      { fileId: "f-coffee", transactionId: "t-client", skipValidation: true },
      CONFIG
    )) as Record<string, unknown>;
    expect(forced.success).toBe(true);

    // MCP connects the same mismatched pair without the agent's checks, as before.
    await seed();
    const mcp = (await handleTool(USER, "connect_file_to_transaction", { fileId: "f-coffee", transactionId: "t-client" })) as {
      success?: boolean;
    };
    expect(mcp.success).toBe(true);
  });

  it("the receipt search and Partner file batch workers replace an automated File Connection; the chat does not", async () => {
    await seedClientInvoice();
    const barrel = (await barrelPromise) as Record<string, Callable>;
    const seedAutomated = async () => {
      await barrel.connectFileToTransaction.run({
        data: { fileId: "f-coffee", transactionId: "t-client", origin: "auto", connectionType: "auto_matched", matchConfidence: 90 },
        auth: { uid: USER, token: {} },
      });
    };
    await seedAutomated();
    const chat = (await tool("connectFileToTransaction").invoke({ fileId: "f-client", transactionId: "t-client" }, CONFIG)) as Record<
      string,
      unknown
    >;
    expect(chat.message).toBe('Connected "client.pdf" to transaction.');
    expect((await db.collection("fileConnections").doc("f-coffee__t-client").get()).exists).toBe(true);

    for (const workerType of ["receipt_search", "partner_file_batch"]) {
      await seed();
      await seedClientInvoice();
      await seedAutomated();
      const worker = (await tool("connectFileToTransaction").invoke(
        { fileId: "f-client", transactionId: "t-client" },
        { configurable: { ...CONFIG.configurable, workerType } }
      )) as Record<string, unknown>;
      expect(worker.message, workerType).toBe('Connected "client.pdf" and reassigned 1 previous auto match.');
      expect((await db.collection("fileConnections").doc("f-coffee__t-client").get()).exists, workerType).toBe(false);
    }
  });

  it("an over-quota Transaction is refused with the agent's message", async () => {
    await seedClientInvoice();
    await db.collection("transactions").doc("t-client").update({ quotaExceeded: true });
    const res = (await tool("connectFileToTransaction").invoke({ fileId: "f-client", transactionId: "t-client" }, CONFIG)) as {
      error?: string;
    };
    expect(res.error).toMatch(/over-quota transactions/);
    expect(await connection()).toBeUndefined();
  });
});

describe("editing a Partner checks the VAT ID with VIES on both surfaces (#665)", () => {
  afterEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("offline", { status: 503 })));
  });

  it("a VAT ID VIES knows: stored, and the reply says so on both surfaces", async () => {
    const calls = viesAnswers(viesXml(true, "AMAZON EU SARL"));
    const chat = (await tool("updatePartner").invoke({ partnerId: "p-amazon", vatId: "atu 1234 5678" }, CONFIG)) as Record<
      string,
      unknown
    >;
    expect(chat.vatIdCheck).toEqual({ vatId: "ATU12345678", valid: true, name: "Amazon Eu Sarl", error: null });
    expect(chat).toMatchObject({ id: "p-amazon", name: "Amazon EU", vatId: "ATU12345678" });
    expect(calls).toHaveLength(1);

    await seed();
    const mcp = (await handleTool(USER, "update_partner", { partnerId: "p-amazon", vatId: "ATU12345678" })) as Record<string, unknown>;
    expect(mcp.vatIdCheck).toEqual(chat.vatIdCheck);
    expect((await db.collection("partners").doc("p-amazon").get()).data()!.vatId).toBe("ATU12345678");
  });

  it("a VAT ID VIES does not know is stored as given, and the reply says it is not valid", async () => {
    viesAnswers(viesXml(false));
    const mcp = (await handleTool(USER, "update_partner", { partnerId: "p-amazon", vatId: "ATU99999999" })) as Record<string, unknown>;
    expect(mcp.vatIdCheck).toEqual({
      vatId: "ATU99999999",
      valid: false,
      name: null,
      error: "VAT ID not valid according to VIES",
    });
    expect((await db.collection("partners").doc("p-amazon").get()).data()!.vatId).toBe("ATU99999999");
  });

  it("VIES down: the VAT ID is stored and the check says VIES was not asked", async () => {
    viesAnswers(null);
    const chat = (await tool("updatePartner").invoke({ partnerId: "p-amazon", vatId: "ATU12345678" }, CONFIG)) as Record<
      string,
      unknown
    >;
    expect(chat.vatIdCheck).toEqual({ vatId: "ATU12345678", valid: null, name: null, error: "HTTP 503" });
    expect((await db.collection("partners").doc("p-amazon").get()).data()!.vatId).toBe("ATU12345678");
  });

  it("VIES names a Partner that has no name; a Partner with one keeps it", async () => {
    viesAnswers(viesXml(true, "ACME HANDELS GMBH"));
    await db.collection("partners").doc("p-nameless").set({
      userId: USER, name: "", aliases: [], isActive: true, createdAt: Timestamp.now(), updatedAt: Timestamp.now(),
    });
    const named = (await handleTool(USER, "update_partner", { partnerId: "p-nameless", vatId: "ATU12345678" })) as Record<string, unknown>;
    expect(named.name).toBe("Acme Handels Gmbh");
    const kept = (await handleTool(USER, "update_partner", { partnerId: "p-amazon", vatId: "ATU12345678" })) as Record<string, unknown>;
    expect(kept.name).toBe("Amazon EU");
  });

  it("no VAT ID, no check and no vatIdCheck; clearing one asks VIES nothing", async () => {
    const calls = viesAnswers(viesXml(true, "X"));
    const res = (await handleTool(USER, "update_partner", { partnerId: "p-amazon", website: "https://amazon.example" })) as Record<
      string,
      unknown
    >;
    expect(res).not.toHaveProperty("vatIdCheck");
    const cleared = (await handleTool(USER, "update_partner", { partnerId: "p-amazon", vatId: "" })) as Record<string, unknown>;
    expect(cleared).not.toHaveProperty("vatIdCheck");
    expect(calls).toHaveLength(0);
  });
});

describe("the caller context is the server's (#665)", () => {
  it("runTool takes only a known worker type, beside the arguments", async () => {
    const barrel = (await barrelPromise) as Record<string, Callable>;
    await expect(
      barrel.runTool.run({
        data: { tool: "get_partner", arguments: { partnerId: "p-amazon" }, workerType: "admin" },
        auth: { uid: USER, token: {} },
      })
    ).rejects.toMatchObject({ code: "invalid-argument" });
  });

  it("the worker types are the agent's", async () => {
    const { getAllWorkerTypes } = await import("@/lib/agent/worker-configs");
    expect([...AGENT_WORKER_TYPES].sort()).toEqual([...getAllWorkerTypes()].sort());
  });
});

describe("guard: a chat tool with an MCP twin never touches the database itself", () => {
  /**
   * Chat tools whose name is an MCP tool's but which keep their own body:
   * each delegates its write to its own callable, and some still read a
   * record first. Wrapping them is not part of #616; this list only shrinks.
   */
  const NOT_YET_WRAPPED = new Set([
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
      assignPartnerToTransaction: { transactionId: "t-client", partnerId: "p-amazon" },
      assignPartnerToFile: { fileId: "f-coffee", partnerId: "p-amazon" },
      updatePartner: { partnerId: "p-amazon", website: "https://amazon.example" },
      connectFileToTransaction: { fileId: "f-coffee", transactionId: "t-fee", skipValidation: true },
    };
    for (const t of wrappedTools) {
      const res = JSON.stringify(await t.invoke(own[t.name] ?? {}, CONFIG));
      expect(res, t.name).not.toContain("touched the database");
      expect(res, t.name).not.toContain('"error"');
    }
  });
});
