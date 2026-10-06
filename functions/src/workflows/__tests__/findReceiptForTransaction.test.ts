/**
 * Tests for findReceiptForTransaction — the deterministic receipt-finding workflow.
 *
 * This is the secret-sauce workflow expressed as TypeScript rather than as
 * a chat-prompt recipe. Same outcome callable by chat agent, MCP, A2A.
 *
 * Stored Files are scored by the matcher (#588), stubbed here so these tests
 * hold the workflow's own decisions: the early exits, where the auto-connect
 * line and the candidate floor sit, the lead, and that Gmail never connects.
 * The matcher's real scores, and the real connect, run on the self-host shim
 * in selfhost/find-receipt.test.ts and selfhost/scorer-parity.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  setupTestHooks,
  store,
  createMockFirestore,
  createTestTransaction,
} from "../../test/setup";
import {
  findReceiptForTransaction,
  FindReceiptDeps,
} from "../findReceiptForTransaction";
import { filesForTransaction } from "../../matching/matcher";

vi.mock("../../matching/matcher", () => ({
  filesForTransaction: vi.fn(),
}));

const scoreStoredFiles = vi.mocked(filesForTransaction);

/** The matcher's answer for the Transaction: these Files at these Confidences. */
function storedFilesScore(...scores: Array<[fileId: string, confidence: number]>) {
  scoreStoredFiles.mockResolvedValue({
    totalCandidates: scores.length,
    matches: scores.map(([fileId, confidence]) => ({
      fileId,
      confidence,
      matchSources: ["amount_exact", "date_exact"],
      breakdown: {} as never,
    })) as never,
    rejectedFileIds: [],
  });
}

function netflixTransaction(overrides: Record<string, unknown> = {}) {
  store.setDoc(
    "transactions",
    "tx-1",
    createTestTransaction({
      userId: "u1",
      amount: -1999,
      partner: "Netflix",
      name: "NETFLIX.COM",
      date: new Date("2026-02-15"),
      ...overrides,
    })
  );
}

function buildDeps(overrides: Partial<FindReceiptDeps> = {}): FindReceiptDeps {
  return {
    db: createMockFirestore() as unknown as FindReceiptDeps["db"],
    searchGmail: vi.fn().mockResolvedValue({ messages: [] }),
    connectFileToTransaction: vi.fn().mockImplementation(async ({ fileId }) => ({ fileId })),
    ...overrides,
  };
}

describe("findReceiptForTransaction", () => {
  setupTestHooks();

  beforeEach(() => {
    storedFilesScore();
  });

  it("skips when the transaction does not exist", async () => {
    const deps = buildDeps();
    const result = await findReceiptForTransaction(
      { transactionId: "missing", userId: "u1" },
      deps
    );
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe("transaction_not_found");
    expect(deps.connectFileToTransaction).not.toHaveBeenCalled();
  });

  it("skips when the transaction already has a file", async () => {
    store.setDoc(
      "transactions",
      "tx-1",
      createTestTransaction({ userId: "u1", fileIds: ["existing-file"] })
    );
    const deps = buildDeps();
    const result = await findReceiptForTransaction(
      { transactionId: "tx-1", userId: "u1" },
      deps
    );
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe("already_has_file");
    expect(deps.connectFileToTransaction).not.toHaveBeenCalled();
  });

  it("skips when the transaction has a no-receipt category", async () => {
    store.setDoc(
      "transactions",
      "tx-1",
      createTestTransaction({
        userId: "u1",
        noReceiptCategoryId: "cat-private",
        noReceiptCategoryTemplateId: "private-personal",
      })
    );
    const deps = buildDeps();
    const result = await findReceiptForTransaction(
      { transactionId: "tx-1", userId: "u1" },
      deps
    );
    expect(result.status).toBe("skipped");
    expect(result.skipReason).toBe("has_no_receipt_category");
  });

  it("returns no_match when no stored File reaches the matcher's suggestion threshold", async () => {
    netflixTransaction();
    storedFilesScore(["file-1", 49]);
    const deps = buildDeps();
    const result = await findReceiptForTransaction(
      { transactionId: "tx-1", userId: "u1" },
      deps
    );
    expect(result.status).toBe("no_match");
    expect(result.sourcesChecked.localFiles).toBe(1);
    expect(deps.connectFileToTransaction).not.toHaveBeenCalled();
  });

  it("surfaces a stored File from 50", async () => {
    netflixTransaction();
    storedFilesScore(["file-1", 50]);
    const deps = buildDeps();
    const result = await findReceiptForTransaction(
      { transactionId: "tx-1", userId: "u1" },
      deps
    );
    expect(result.status).toBe("needs_review");
    expect(result.candidates).toEqual([
      expect.objectContaining({
        source: "local_file",
        fileId: "file-1",
        score: 50,
        label: "Likely",
        reasons: ["amount_exact", "date_exact"],
      }),
    ]);
  });

  it("auto-connects a stored File at 85 with a 10-point lead", async () => {
    netflixTransaction();
    storedFilesScore(["file-netflix", 85], ["file-other", 75]);
    const deps = buildDeps();
    const result = await findReceiptForTransaction(
      { transactionId: "tx-1", userId: "u1" },
      deps
    );
    expect(result).toMatchObject({ status: "connected", fileId: "file-netflix", confidence: 85 });
    expect(deps.connectFileToTransaction).toHaveBeenCalledWith({
      userId: "u1",
      transactionId: "tx-1",
      fileId: "file-netflix",
      matchConfidence: 85,
      connectionType: "auto_matched",
    });
  });

  it("does not auto-connect a stored File at 84", async () => {
    netflixTransaction();
    storedFilesScore(["file-netflix", 84]);
    const deps = buildDeps();
    const result = await findReceiptForTransaction(
      { transactionId: "tx-1", userId: "u1" },
      deps
    );
    expect(result.status).toBe("needs_review");
    expect(result.candidates?.map((c) => c.fileId)).toEqual(["file-netflix"]);
    expect(deps.connectFileToTransaction).not.toHaveBeenCalled();
  });

  it("does not auto-connect a stored File at 85 without a 10-point lead", async () => {
    netflixTransaction();
    storedFilesScore(["file-a", 85], ["file-b", 76]);
    const deps = buildDeps();
    const result = await findReceiptForTransaction(
      { transactionId: "tx-1", userId: "u1" },
      deps
    );
    expect(result.status).toBe("needs_review");
    expect(result.candidates?.map((c) => c.fileId)).toEqual(["file-a", "file-b"]);
    expect(deps.connectFileToTransaction).not.toHaveBeenCalled();
  });

  it("does not auto-connect onto an over-quota Transaction", async () => {
    netflixTransaction({ quotaExceeded: true });
    storedFilesScore(["file-netflix", 95]);
    const deps = buildDeps();
    const result = await findReceiptForTransaction(
      { transactionId: "tx-1", userId: "u1" },
      deps
    );
    expect(result.status).toBe("needs_review");
    expect(deps.connectFileToTransaction).not.toHaveBeenCalled();
  });

  it("asks the matcher about this Transaction only", async () => {
    netflixTransaction();
    const deps = buildDeps();
    await findReceiptForTransaction({ transactionId: "tx-1", userId: "u1" }, deps);
    expect(scoreStoredFiles).toHaveBeenCalledTimes(1);
    const [, userId, txSnap] = scoreStoredFiles.mock.calls[0];
    expect(userId).toBe("u1");
    expect(txSnap.id).toBe("tx-1");
  });

  it("does not call searchGmail when there are no active integrations", async () => {
    store.setDoc(
      "transactions",
      "tx-1",
      createTestTransaction({
        userId: "u1",
        amount: -1999,
        partner: "Netflix",
        date: new Date("2026-02-15"),
      })
    );
    const deps = buildDeps();
    await findReceiptForTransaction({ transactionId: "tx-1", userId: "u1" }, deps);
    expect(deps.searchGmail).not.toHaveBeenCalled();
  });

  it("includes Gmail attachments as candidates when integrations exist", async () => {
    store.setDoc(
      "transactions",
      "tx-1",
      createTestTransaction({
        userId: "u1",
        amount: -1999,
        partner: "Netflix",
        date: new Date("2026-02-15"),
      })
    );
    store.setDoc("emailIntegrations", "int-1", {
      userId: "u1",
      provider: "gmail",
      isActive: true,
      needsReauth: false,
      email: "felix@example.com",
    });
    const searchGmail = vi.fn().mockResolvedValue({
      messages: [
        {
          messageId: "msg-1",
          threadId: "thr-1",
          subject: "Your Netflix invoice",
          from: "billing@netflix.com",
          date: "2026-02-15T08:00:00Z",
          snippet: "Netflix invoice for 19.99 EUR",
          bodyText: "Total: 19.99 EUR",
          integrationId: "int-1",
          attachments: [
            {
              attachmentId: "att-1",
              filename: "netflix_invoice_2026_02.pdf",
              mimeType: "application/pdf",
            },
          ],
          classification: {
            hasPdfAttachment: true,
            possibleMailInvoice: false,
            possibleInvoiceLink: false,
            confidence: 60,
          },
        },
      ],
    });
    const deps = buildDeps({ searchGmail });

    const result = await findReceiptForTransaction(
      { transactionId: "tx-1", userId: "u1" },
      deps
    );
    expect(searchGmail).toHaveBeenCalledTimes(1);
    expect(searchGmail).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        integrationIds: ["int-1"],
        // The workflow now builds a combined OR-query via the typed-suggestion
        // generator, which lowercases terms — assert case-insensitively.
        query: expect.stringMatching(/netflix/i),
      })
    );
    expect(result.sourcesChecked.gmailAttachments).toBe(1);
    // Gmail attachments do NOT auto-connect (we don't auto-download)
    expect(deps.connectFileToTransaction).not.toHaveBeenCalled();
    expect(result.status === "needs_review" || result.status === "connected").toBeTruthy();
    if (result.status === "needs_review") {
      expect(
        result.candidates!.some((c) => c.source === "gmail_attachment")
      ).toBe(true);
    }
  });

  it("searches an IMAP Mail Integration too, handing it the suggestions as neutral terms (#746)", async () => {
    store.setDoc(
      "transactions",
      "tx-1",
      createTestTransaction({
        userId: "u1",
        amount: -1999,
        partner: "Netflix",
        date: new Date("2026-02-15"),
      })
    );
    store.setDoc("emailIntegrations", "imap-1", {
      userId: "u1",
      provider: "imap",
      isActive: true,
      needsReauth: false,
      email: "stefan@example.com",
    });
    const deps = buildDeps();

    await findReceiptForTransaction({ transactionId: "tx-1", userId: "u1" }, deps);

    expect(deps.searchGmail).toHaveBeenCalledTimes(1);
    const args = (deps.searchGmail as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.integrationIds).toEqual(["imap-1"]);
    expect(args.terms.length).toBeGreaterThan(0);
    expect(JSON.stringify(args.terms)).toMatch(/netflix/i);
  });

  it("filters out integrations needing reauth", async () => {
    store.setDoc(
      "transactions",
      "tx-1",
      createTestTransaction({
        userId: "u1",
        amount: -1999,
        partner: "Netflix",
        date: new Date("2026-02-15"),
      })
    );
    store.setDoc("emailIntegrations", "int-broken", {
      userId: "u1",
      provider: "gmail",
      isActive: true,
      needsReauth: true,
    });
    const deps = buildDeps();
    await findReceiptForTransaction({ transactionId: "tx-1", userId: "u1" }, deps);
    expect(deps.searchGmail).not.toHaveBeenCalled();
  });

  it("never auto-connects a Gmail candidate, whatever its rank", async () => {
    netflixTransaction();
    store.setDoc("emailIntegrations", "int-1", {
      userId: "u1",
      provider: "gmail",
      isActive: true,
      needsReauth: false,
    });
    // Nothing stored competes: the mail is the top candidate and alone.
    const searchGmail = vi.fn().mockResolvedValue({
      messages: [
        {
          messageId: "msg-1",
          threadId: "thr-1",
          subject: "Your Netflix invoice 19.99 EUR",
          from: "billing@netflix.com",
          date: "2026-02-15T08:00:00Z",
          snippet: "Netflix invoice, total 19.99 EUR",
          bodyText: "Netflix. Total: 19.99 EUR",
          integrationId: "int-1",
          attachments: [
            {
              attachmentId: "att-1",
              filename: "netflix_invoice_2026_02.pdf",
              mimeType: "application/pdf",
            },
          ],
          classification: { hasPdfAttachment: true, confidence: 90 },
        },
      ],
    });
    const deps = buildDeps({ searchGmail });
    const result = await findReceiptForTransaction(
      { transactionId: "tx-1", userId: "u1" },
      deps
    );
    expect(result.status).toBe("needs_review");
    expect(result.candidates?.[0]).toMatchObject({ source: "gmail_attachment" });
    expect(result.candidates![0].score).toBeGreaterThanOrEqual(85);
    expect(deps.connectFileToTransaction).not.toHaveBeenCalled();
  });
});
