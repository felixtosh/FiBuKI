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

  return { getAdminDb: () => ({ collection }) };
});

const { connectFileToTransactionTool, searchLocalFilesTool, searchGmailAttachmentsTool } =
  await import("@/lib/agent/tools/search-tools");
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

describe("connectFileToTransaction — dismissal gate", () => {
  it("refuses a pair the file has rejected, without writing", async () => {
    seedFile("f-1", { dismissedTransactionIds: ["tx-1"] });
    seedTransaction("tx-1");

    const result = (await connectFileToTransactionTool.invoke(
      { fileId: "f-1", transactionId: "tx-1", skipValidation: true },
      chatConfig
    )) as Doc;

    expect(result.error).toBe("PAIR_REJECTED");
    expect(String(result.message)).toContain("undismiss_transaction_suggestion");
    expect(h.callFirebaseFunction).not.toHaveBeenCalled();
  });

  it("refuses on the record shape too, not only the legacy id array", async () => {
    seedFile("f-1", {
      dismissedTransactions: [{ transactionId: "tx-1", dismissedAt: new Date() }],
    });
    seedTransaction("tx-1");

    const result = (await connectFileToTransactionTool.invoke(
      { fileId: "f-1", transactionId: "tx-1", skipValidation: true },
      chatConfig
    )) as Doc;

    expect(result.error).toBe("PAIR_REJECTED");
  });

  it("is not lifted by skipValidation", async () => {
    // The whole point of putting the gate outside the validation block: the
    // batch workers pass skipValidation routinely.
    seedFile("f-1", { dismissedTransactionIds: ["tx-1"] });
    seedTransaction("tx-1");

    const result = (await connectFileToTransactionTool.invoke(
      { fileId: "f-1", transactionId: "tx-1", skipValidation: true },
      batchConfig
    )) as Doc;

    expect(result.error).toBe("PAIR_REJECTED");
    expect(h.callFirebaseFunction).not.toHaveBeenCalled();
  });

  it("connects when the caller explicitly overrides", async () => {
    seedFile("f-1", { dismissedTransactionIds: ["tx-1"] });
    seedTransaction("tx-1");

    const result = (await connectFileToTransactionTool.invoke(
      {
        fileId: "f-1",
        transactionId: "tx-1",
        skipValidation: true,
        overrideDismissal: true,
      },
      chatConfig
    )) as Doc;

    expect(result.success).toBe(true);
    expect(h.callFirebaseFunction).toHaveBeenCalledWith(
      "connectFileToTransaction",
      expect.objectContaining({ fileId: "f-1", transactionId: "tx-1" }),
      "Bearer test"
    );
  });

  it("connects a pair that was rejected and then un-rejected", async () => {
    seedFile("f-1", {
      dismissedTransactionIds: [],
      dismissedTransactions: [
        { transactionId: "tx-1", dismissedAt: new Date(), undismissedAt: new Date() },
      ],
    });
    seedTransaction("tx-1");

    const result = (await connectFileToTransactionTool.invoke(
      { fileId: "f-1", transactionId: "tx-1", skipValidation: true },
      chatConfig
    )) as Doc;

    expect(result.success).toBe(true);
  });

  it("leaves a non-dismissed pair connecting exactly as before", async () => {
    seedFile("f-1", { dismissedTransactionIds: ["tx-other"] });
    seedTransaction("tx-1");

    const result = (await connectFileToTransactionTool.invoke(
      { fileId: "f-1", transactionId: "tx-1", skipValidation: true },
      chatConfig
    )) as Doc;

    expect(result.success).toBe(true);
    expect(h.callFirebaseFunction).toHaveBeenCalledTimes(1);
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

describe("searchLocalFiles — dismissed candidates are not offered", () => {
  beforeEach(() => {
    // The scorer is exercised by its own suite; here it just has to answer for
    // whatever survives the filter, so the assertion is about which keys arrive.
    h.callFirebaseFunction.mockImplementation(async (_name: string, payload: Doc) => ({
      scores: ((payload.attachments as Array<{ key: string }>) || []).map((a) => ({
        key: a.key,
        score: 80,
        label: "Strong",
        reasons: ["amount match"],
      })),
    }));
  });

  it("drops a file that has rejected this transaction, before scoring it", async () => {
    seedFile("f-1", { dismissedTransactionIds: ["tx-1"] });
    seedFile("f-2");
    seedTransaction("tx-1");

    const result = (await searchLocalFilesTool.invoke(
      { transactionId: "tx-1" },
      chatConfig
    )) as {
      candidates: Array<{ fileId: string }>;
      totalFound: number;
      dismissedForThisTransaction: number;
      summary: string;
    };

    expect(result.candidates.map((c) => c.fileId)).toEqual(["f-2"]);
    expect(result.totalFound).toBe(1);
    expect(result.dismissedForThisTransaction).toBe(1);
    expect(result.summary).toContain("previously rejected");

    // Dropped before scoring, not filtered out of the scored list.
    const scored = h.callFirebaseFunction.mock.calls[0][1] as {
      attachments: Array<{ key: string }>;
    };
    expect(scored.attachments.map((a) => a.key)).toEqual(["local_f-2"]);
  });

  it("offers a file that dismissed a different transaction", async () => {
    seedFile("f-1", { dismissedTransactionIds: ["tx-other"] });
    seedTransaction("tx-1");

    const result = (await searchLocalFilesTool.invoke(
      { transactionId: "tx-1" },
      chatConfig
    )) as { candidates: Array<{ fileId: string }>; dismissedForThisTransaction: number };

    expect(result.candidates.map((c) => c.fileId)).toEqual(["f-1"]);
    expect(result.dismissedForThisTransaction).toBe(0);
  });

  it("says so rather than reporting an empty library when every file was rejected", async () => {
    seedFile("f-1", { dismissedTransactionIds: ["tx-1"] });
    seedTransaction("tx-1");

    const result = (await searchLocalFilesTool.invoke(
      { transactionId: "tx-1" },
      chatConfig
    )) as { candidates: unknown[]; dismissedForThisTransaction: number; summary: string };

    expect(result.candidates).toHaveLength(0);
    expect(result.dismissedForThisTransaction).toBe(1);
    // Otherwise an agent reads "no files" and goes looking for a document that
    // is already here and was deliberately refused.
    expect(result.summary).toContain("previously rejected");
    expect(h.callFirebaseFunction).not.toHaveBeenCalled();
  });
});

describe("scoreBatchMatches — the NxM matrix the batcher connects from", () => {
  beforeEach(() => {
    h.callFirebaseFunction.mockImplementation(async () => ({ confidence: 95, breakdown: null }));
  });

  it("does not score a dismissed pair, so it cannot win an assignment slot", async () => {
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
    expect(h.callFirebaseFunction).toHaveBeenCalledTimes(1);
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
