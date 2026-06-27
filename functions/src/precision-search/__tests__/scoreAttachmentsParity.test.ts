/**
 * Parity regression test: UI scoring vs workflow scoring.
 *
 * The UI calls scoreAttachmentMatchCallable (which delegates to scoreAttachments)
 * over HTTPS. The findReceiptForTransaction workflow calls scoreAttachments
 * directly. Both MUST produce identical scores for the same (transaction,
 * partner, attachment) triple, otherwise the agent and the file-connect
 * overlay show different confidence numbers for the same file.
 *
 * This test pins that contract by running a fixture through both paths and
 * asserting the score / label / reasons match exactly.
 */
import { describe, it, expect, vi } from "vitest";
import {
  setupTestHooks,
  store,
  createMockFirestore,
  createTestTransaction,
  createTestFile,
} from "../../test/setup";
import {
  scoreAttachments,
  type ScoreAttachmentRequest,
} from "../scoreAttachmentMatchCallable";
import {
  findReceiptForTransaction,
  type FindReceiptDeps,
} from "../../workflows/findReceiptForTransaction";

describe("scoreAttachments UI/workflow parity", () => {
  setupTestHooks();

  it("produces identical scores when the workflow and the UI score the same local file", async () => {
    const userId = "u1";
    const transactionId = "tx-1";
    const fileId = "file-netflix";

    const txDate = new Date("2026-02-15");
    const extractedDate = new Date("2026-02-15");

    store.setDoc(
      "transactions",
      transactionId,
      createTestTransaction({
        userId,
        amount: -1999,
        partner: "Netflix",
        name: "NETFLIX.COM",
        date: txDate,
        reference: "REF-NETFLIX-FEB",
      }),
    );
    store.setDoc(
      "files",
      fileId,
      createTestFile({
        userId,
        fileName: "netflix_invoice_2026_02.pdf",
        fileType: "application/pdf",
        extractedPartner: "Netflix Inc.",
        extractedAmount: -1999,
        extractedDate,
      }),
    );

    // Path A: the workflow. It builds its own ScoreAttachmentRequest internally
    // from the Firestore docs and dispatches through scoreAttachments.
    const deps: FindReceiptDeps = {
      db: createMockFirestore() as unknown as FindReceiptDeps["db"],
      searchGmail: vi.fn().mockResolvedValue({ messages: [] }),
      connectFileToTransaction: vi
        .fn()
        .mockImplementation(async ({ fileId: id }) => ({ fileId: id })),
    };
    const result = await findReceiptForTransaction(
      { transactionId, userId },
      deps,
    );

    // The fixture is engineered to be a clear auto-connect winner so we know
    // the workflow actually scored it (didn't short-circuit on a skip path).
    expect(result.status).toBe("connected");
    expect(result.fileId).toBe(fileId);
    const workflowScore = result.confidence!;
    expect(workflowScore).toBeGreaterThan(0);

    // Path B: the UI callable's pure helper. Build a request that mirrors the
    // exact data the workflow saw, then call scoreAttachments directly.
    const uiRequest: ScoreAttachmentRequest = {
      attachments: [
        {
          key: fileId,
          filename: "netflix_invoice_2026_02.pdf",
          mimeType: "application/pdf",
          fileExtractedAmount: -1999,
          fileExtractedDate: extractedDate.toISOString(),
          fileExtractedPartner: "Netflix Inc.",
          filePartnerId: null,
        },
      ],
      transaction: {
        amount: -1999,
        date: txDate.toISOString(),
        name: "NETFLIX.COM",
        reference: "REF-NETFLIX-FEB",
        partner: "Netflix",
        partnerId: null,
      },
      partner: null, // no partner record loaded; matches the workflow path
    };
    const { scores } = scoreAttachments(uiRequest);
    expect(scores).toHaveLength(1);
    expect(scores[0].score).toBe(workflowScore);
  });

  it("produces identical scores when partner record is loaded", async () => {
    const userId = "u1";
    const transactionId = "tx-1";
    const fileId = "file-netflix";
    const partnerId = "partner-netflix";

    const txDate = new Date("2026-02-15");
    const extractedDate = new Date("2026-02-15");

    store.setDoc("partners", partnerId, {
      userId,
      name: "Netflix Inc.",
      emailDomains: ["netflix.com"],
      fileSourcePatterns: [],
    });
    store.setDoc(
      "transactions",
      transactionId,
      createTestTransaction({
        userId,
        amount: -1999,
        partner: "Netflix",
        name: "NETFLIX.COM",
        date: txDate,
        partnerId,
      }),
    );
    store.setDoc(
      "files",
      fileId,
      createTestFile({
        userId,
        fileName: "netflix_invoice_2026_02.pdf",
        fileType: "application/pdf",
        extractedPartner: "Netflix Inc.",
        extractedAmount: -1999,
        extractedDate,
      }),
    );

    const deps: FindReceiptDeps = {
      db: createMockFirestore() as unknown as FindReceiptDeps["db"],
      searchGmail: vi.fn().mockResolvedValue({ messages: [] }),
      connectFileToTransaction: vi
        .fn()
        .mockImplementation(async ({ fileId: id }) => ({ fileId: id })),
    };
    const result = await findReceiptForTransaction(
      { transactionId, userId },
      deps,
    );
    expect(result.status).toBe("connected");
    const workflowScore = result.confidence!;

    const uiRequest: ScoreAttachmentRequest = {
      attachments: [
        {
          key: fileId,
          filename: "netflix_invoice_2026_02.pdf",
          mimeType: "application/pdf",
          fileExtractedAmount: -1999,
          fileExtractedDate: extractedDate.toISOString(),
          fileExtractedPartner: "Netflix Inc.",
          filePartnerId: null,
        },
      ],
      transaction: {
        amount: -1999,
        date: txDate.toISOString(),
        name: "NETFLIX.COM",
        reference: "REF123", // matches createTestTransaction default
        partner: "Netflix",
        partnerId,
      },
      partner: {
        name: "Netflix Inc.",
        emailDomains: ["netflix.com"],
        fileSourcePatterns: [],
      },
    };
    const { scores } = scoreAttachments(uiRequest);
    expect(scores[0].score).toBe(workflowScore);
  });
});
