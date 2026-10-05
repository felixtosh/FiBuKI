/**
 * The agent tools enforce a rejected file-to-transaction pair (fork #101).
 *
 * Fork #94 closed every deterministic path but could only hand the agentic
 * path prompt text, and a steer is not a gate. Two shapes made that reachable
 * rather than theoretical: the partner batch worker gets no dismissal list at
 * all (its prompt aggregates many files, so a per-file exclusion list does not
 * fit), and #94 makes a file whose only strong candidate was dismissed look
 * unmatched, which queues the single-file worker on every re-score.
 *
 * The single-pair connect's gate moved into the shared connect tool (#665):
 * connectFileToTransaction wraps it, and functions/src/selfhost/chat-mcp-tools.test.ts
 * holds the gate there. Here only the wrapper's hand-off is checked.
 *
 * Covers repo-root lib/agent/tools/, so it runs under vitest.api-smoke.config.ts
 * ONLY (needs the root dependency tree for @langchain/core).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

type Doc = Record<string, unknown>;

const h = vi.hoisted(() => ({
  state: {
    files: new Map<string, Record<string, unknown>>(),
    transactions: new Map<string, Record<string, unknown>>(),
    partners: new Map<string, Record<string, unknown>>(),
    emailIntegrations: new Map<string, Record<string, unknown>>(),
  },
  callFirebaseFunction: vi.fn(),
}));

vi.mock("@/lib/api/firebase-callable", () => ({
  callFirebaseFunction: (...args: unknown[]) => h.callFirebaseFunction(...args),
}));

vi.mock("@/lib/firebase/admin", () => {
  const snap = (id: string, data: Doc | undefined) => ({
    id,
    exists: data !== undefined,
    data: () => data,
    ref: { id },
  });

  const emptyResult = { docs: [], empty: true, size: 0 };

  const collection = (name: string) => {
    const query = {
      where: () => query,
      orderBy: () => query,
      limit: () => query,
      get: async () => {
        const store =
          name === "files"
            ? h.state.files
            : name === "emailIntegrations"
              ? h.state.emailIntegrations
              : null;
        if (!store) {
          // fileConnections answers empty: none of these tests drive an
          // already-connected pair.
          return emptyResult;
        }
        const docs = [...store].map(([id, data]) => snap(id, data));
        return { docs, empty: docs.length === 0, size: docs.length };
      },
      doc: (id: string) => ({
        id,
        get: async () => {
          const store =
            name === "files"
              ? h.state.files
              : name === "transactions"
                ? h.state.transactions
                : h.state.partners;
          return snap(id, store.get(id));
        },
      }),
    };
    return query;
  };

  const getAll = (...refs: Array<{ get: () => Promise<unknown> }>) => Promise.all(refs.map((r) => r.get()));

  return { getAdminDb: () => ({ collection, getAll }) };
});

const { searchLocalFilesTool, searchGmailAttachmentsTool } = await import("@/lib/agent/tools/search-tools");
const { connectFileToTransactionTool } = await import("@/lib/agent/tools/mcp-tools");
const { bulkConnectFilesTool, scoreBatchMatchesTool } = await import(
  "@/lib/agent/tools/batch-tools"
);

const userId = "user-1";
const chatConfig = { configurable: { userId, authHeader: "Bearer test" } };
// The path #94 could not reach with prompt text.
const batchConfig = {
  configurable: { userId, authHeader: "Bearer test", workerType: "partner_file_batch" },
};

function seedTransaction(id: string, overrides: Doc = {}) {
  h.state.transactions.set(id, {
    userId,
    name: "ACME GmbH",
    amount: -12000,
    currency: "EUR",
    date: new Date("2026-03-05"),
    fileIds: [],
    ...overrides,
  });
}

function seedFile(id: string, overrides: Doc = {}) {
  h.state.files.set(id, {
    userId,
    fileName: `${id}.pdf`,
    fileType: "application/pdf",
    extractedAmount: -12000,
    extractedCurrency: "EUR",
    extractedPartner: "ACME GmbH",
    transactionIds: [],
    ...overrides,
  });
}

beforeEach(() => {
  h.state.files.clear();
  h.state.transactions.clear();
  h.state.partners.clear();
  h.state.emailIntegrations.clear();
  h.callFirebaseFunction.mockReset();
  h.callFirebaseFunction.mockResolvedValue({ connectionId: "conn-1" });
});

describe("connectFileToTransaction — the gate is the shared tool's (#665)", () => {
  it("hands the pair, the override and skipValidation to runTool, the worker type beside them, and reads nothing itself", async () => {
    h.callFirebaseFunction.mockResolvedValue({ error: "PAIR_REJECTED", message: "undismiss_transaction_suggestion" });
    seedFile("f-1", { dismissedTransactionIds: ["tx-1"] });
    seedTransaction("tx-1");

    const result = (await connectFileToTransactionTool.invoke(
      { fileId: "f-1", transactionId: "tx-1", skipValidation: true, overrideDismissal: true },
      batchConfig
    )) as Doc;

    // The shared tool's refusal reaches the model as it is.
    expect(result).toEqual({ error: "PAIR_REJECTED", message: "undismiss_transaction_suggestion" });
    expect(h.callFirebaseFunction).toHaveBeenCalledTimes(1);
    expect(h.callFirebaseFunction).toHaveBeenCalledWith(
      "runTool",
      {
        tool: "connect_file_to_transaction",
        arguments: { fileId: "f-1", transactionId: "tx-1", skipValidation: true, overrideDismissal: true },
        workerType: "partner_file_batch",
      },
      "Bearer test"
    );
  });

  it("the chat itself sends no worker type", async () => {
    h.callFirebaseFunction.mockResolvedValue({ success: true });
    await connectFileToTransactionTool.invoke({ fileId: "f-1", transactionId: "tx-1" }, chatConfig);
    const [, data] = h.callFirebaseFunction.mock.calls[0] as [string, Record<string, unknown>];
    expect(data).not.toHaveProperty("workerType");
  });
});

describe("bulkConnectFiles — the partner-batch write path", () => {
  it("refuses the dismissed pair and connects the rest of the batch", async () => {
    seedFile("f-1", { dismissedTransactionIds: ["tx-1"] });
    seedFile("f-2");
    seedTransaction("tx-1");
    seedTransaction("tx-2");

    const result = (await bulkConnectFilesTool.invoke(
      {
        connections: [
          { fileId: "f-1", transactionId: "tx-1", confidence: 95 },
          { fileId: "f-2", transactionId: "tx-2", confidence: 90 },
        ],
      },
      batchConfig
    )) as { results: Array<Doc>; dismissedPairsRefused: number; summary: string };

    const refused = result.results.find((r) => r.fileId === "f-1")!;
    const connected = result.results.find((r) => r.fileId === "f-2")!;

    expect(refused.success).toBe(false);
    expect(String(refused.error)).toContain("PAIR_REJECTED");
    expect(connected.success).toBe(true);
    expect(result.dismissedPairsRefused).toBe(1);
    expect(result.summary).toContain("do not retry");

    // Only the surviving pair reached the callable.
    expect(h.callFirebaseFunction).toHaveBeenCalledTimes(1);
    expect(h.callFirebaseFunction).toHaveBeenCalledWith(
      "connectFileToTransaction",
      expect.objectContaining({ fileId: "f-2" }),
      "Bearer test"
    );
  });

  it("connects a whole batch untouched when nothing is dismissed", async () => {
    seedFile("f-1");
    seedFile("f-2");
    seedTransaction("tx-1");
    seedTransaction("tx-2");

    const result = (await bulkConnectFilesTool.invoke(
      {
        connections: [
          { fileId: "f-1", transactionId: "tx-1", confidence: 95 },
          { fileId: "f-2", transactionId: "tx-2", confidence: 90 },
        ],
      },
      batchConfig
    )) as { results: Array<Doc>; dismissedPairsRefused: number };

    expect(result.results.every((r) => r.success)).toBe(true);
    expect(result.dismissedPairsRefused).toBe(0);
    expect(h.callFirebaseFunction).toHaveBeenCalledTimes(2);
  });
});

describe("searchLocalFiles — the matcher decides what is offered (#613)", () => {
  /** The matcher's answer: these Files, and how many it held back as rejected. */
  function matcherAnswers(fileIds: string[], rejectedCount = 0) {
    h.callFirebaseFunction.mockImplementation(async (name: string) => {
      if (name !== "findFileMatchesForTransaction") throw new Error(`unexpected ${name}`);
      return {
        matches: fileIds.map((fileId) => ({ fileId, confidence: 80, matchSources: ["amount_exact"] })),
        totalCandidates: fileIds.length,
        rejectedFileIds: Array.from({ length: rejectedCount }, (_, i) => `f-rejected-${i}`),
      };
    });
  }

  it("offers what the matcher ranks, and says how many it held back as rejected", async () => {
    seedFile("f-2");
    seedTransaction("tx-1");
    matcherAnswers(["f-2"], 1);

    const result = (await searchLocalFilesTool.invoke(
      { transactionId: "tx-1" },
      chatConfig
    )) as {
      candidates: Array<{ fileId: string; score: number; scoreReasons: string[] }>;
      totalFound: number;
      dismissedForThisTransaction: number;
      summary: string;
    };

    expect(result.candidates).toEqual([
      expect.objectContaining({ fileId: "f-2", score: 80, scoreReasons: ["amount_exact"] }),
    ]);
    expect(result.totalFound).toBe(1);
    expect(result.dismissedForThisTransaction).toBe(1);
    expect(result.summary).toContain("previously rejected");
    expect(h.callFirebaseFunction).toHaveBeenCalledWith(
      "findFileMatchesForTransaction",
      expect.objectContaining({ transactionId: "tx-1" }),
      "Bearer test"
    );
  });

  it("says so rather than reporting an empty library when every file was rejected", async () => {
    seedFile("f-1", { dismissedTransactionIds: ["tx-1"] });
    seedTransaction("tx-1");
    matcherAnswers([], 1);

    const result = (await searchLocalFilesTool.invoke(
      { transactionId: "tx-1" },
      chatConfig
    )) as { candidates: unknown[]; dismissedForThisTransaction: number; summary: string };

    expect(result.candidates).toHaveLength(0);
    expect(result.dismissedForThisTransaction).toBe(1);
    // Otherwise an agent reads "no files" and goes looking for a document that
    // is already here and was deliberately refused.
    expect(result.summary).toContain("previously rejected");
  });
});

describe("scoreBatchMatches — the NxM matrix the batcher connects from", () => {
  beforeEach(() => {
    // The matcher's answer per pair: f-1 rejected tx-1.
    h.callFirebaseFunction.mockImplementation(
      async (_name: string, pair: { fileId: string; transactionId: string }) => ({
        confidence: 95,
        breakdown: null,
        ineligible: null,
        hidden: pair.fileId === "f-1" && pair.transactionId === "tx-1" ? "rejected" : null,
      })
    );
  });

  it("leaves a pair the matcher holds back out, so it cannot win an assignment slot", async () => {
    seedFile("f-1", { dismissedTransactionIds: ["tx-1"] });
    seedFile("f-2");
    seedTransaction("tx-1");
    seedTransaction("tx-2");

    const result = (await scoreBatchMatchesTool.invoke(
      {
        pairs: [
          { fileId: "f-1", transactionId: "tx-1" },
          { fileId: "f-2", transactionId: "tx-2" },
        ],
      },
      batchConfig
    )) as {
      allScores: Array<{ fileId: string }>;
      recommendedAssignments: Array<{ fileId: string; transactionId: string }>;
      dismissedPairsSkipped: number;
      summary: string;
    };

    expect(result.dismissedPairsSkipped).toBe(1);
    expect(result.allScores.map((s) => s.fileId)).toEqual(["f-2"]);
    expect(
      result.recommendedAssignments.some((a) => a.fileId === "f-1" && a.transactionId === "tx-1")
    ).toBe(false);
    expect(result.summary).toContain("do not propose");
  });

  it("still scores the same file against a transaction it has not rejected", async () => {
    seedFile("f-1", { dismissedTransactionIds: ["tx-1"] });
    seedTransaction("tx-1");
    seedTransaction("tx-2");

    const result = (await scoreBatchMatchesTool.invoke(
      {
        pairs: [
          { fileId: "f-1", transactionId: "tx-1" },
          { fileId: "f-1", transactionId: "tx-2" },
        ],
      },
      batchConfig
    )) as {
      allScores: Array<{ transactionId: string }>;
      dismissedPairsSkipped: number;
    };

    expect(result.dismissedPairsSkipped).toBe(1);
    expect(result.allScores.map((s) => s.transactionId)).toEqual(["tx-2"]);
  });
});

describe("searchGmailAttachments — an already-downloaded rejected file is not re-offered", () => {
  function seedGmail(existingFileId: string | null) {
    h.state.emailIntegrations.set("integration-1", {
      userId,
      email: "stefan@example.com",
      provider: "gmail",
    });

    h.callFirebaseFunction.mockImplementation(async (name: string, payload: Doc) => {
      if (name === "searchGmailCallable") {
        return {
          messages: [
            {
              messageId: "m-1",
              subject: "Invoice 2026-03",
              from: "billing@acme.example",
              snippet: "your invoice is attached",
              date: "2026-03-05T00:00:00.000Z",
              attachments: [
                {
                  attachmentId: "a-1",
                  filename: "invoice.pdf",
                  mimeType: "application/pdf",
                  existingFileId,
                },
              ],
            },
          ],
        };
      }
      return {
        scores: ((payload.attachments as Array<{ key: string }>) || []).map((a) => ({
          key: a.key,
          score: 80,
          label: "Strong",
          reasons: ["amount match"],
        })),
      };
    });
  }

  it("drops the candidate whose downloaded file has rejected this transaction", async () => {
    seedFile("f-1", { dismissedTransactionIds: ["tx-1"] });
    seedTransaction("tx-1");
    seedGmail("f-1");

    const result = (await searchGmailAttachmentsTool.invoke(
      { transactionId: "tx-1", searchQueries: ["ACME"] },
      chatConfig
    )) as {
      candidates: unknown[];
      totalFound: number;
      dismissedForThisTransaction: number;
      summary: string;
    };

    expect(result.candidates).toHaveLength(0);
    expect(result.totalFound).toBe(0);
    expect(result.dismissedForThisTransaction).toBe(1);
    expect(result.summary).toContain("previously rejected");
  });

  it("keeps an attachment that is not a file yet — it has nothing to reject with", async () => {
    seedTransaction("tx-1");
    seedGmail(null);

    const result = (await searchGmailAttachmentsTool.invoke(
      { transactionId: "tx-1", searchQueries: ["ACME"] },
      chatConfig
    )) as { candidates: unknown[]; dismissedForThisTransaction: number };

    expect(result.candidates).toHaveLength(1);
    expect(result.dismissedForThisTransaction).toBe(0);
  });
});
