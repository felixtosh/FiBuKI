/**
 * Tests for findReceiptForTransaction — the deterministic receipt-finding workflow.
 *
 * This is the secret-sauce workflow expressed as TypeScript rather than as
 * a chat-prompt recipe. Same outcome callable by chat agent, MCP, A2A.
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
  findReceiptForTransaction,
  FindReceiptDeps,
} from "../findReceiptForTransaction";

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

  it("returns no_match when nothing scores above the floor", async () => {
    store.setDoc(
      "transactions",
      "tx-1",
      createTestTransaction({
        userId: "u1",
        amount: -1999,
        partner: "Netflix",
        name: "NETFLIX.COM",
        date: new Date("2026-02-15"),
      })
    );
    // An unrelated file the user has uploaded
    store.setDoc(
      "files",
      "file-1",
      createTestFile({
        userId: "u1",
        fileName: "completely_unrelated_grocery.jpg",
        extractedPartner: "Billa",
        extractedAmount: -550,
      })
    );
    const deps = buildDeps();
    const result = await findReceiptForTransaction(
      { transactionId: "tx-1", userId: "u1" },
      deps
    );
    expect(result.status).toBe("no_match");
    expect(result.sourcesChecked.localFiles).toBe(1);
    expect(deps.connectFileToTransaction).not.toHaveBeenCalled();
  });

  it("auto-connects when a single local file scores strongly", async () => {
    store.setDoc(
      "transactions",
      "tx-1",
      createTestTransaction({
        userId: "u1",
        amount: -1999,
        partner: "Netflix",
        name: "NETFLIX.COM",
        date: new Date("2026-02-15"),
      })
    );
    store.setDoc(
      "files",
      "file-netflix",
      createTestFile({
        userId: "u1",
        fileName: "netflix_invoice_2026_02.pdf",
        fileType: "application/pdf",
        extractedPartner: "Netflix Inc.",
        extractedAmount: -1999,
        extractedDate: new Date("2026-02-15"),
      })
    );
    const deps = buildDeps();
    const result = await findReceiptForTransaction(
      { transactionId: "tx-1", userId: "u1" },
      deps
    );
    expect(result.status).toBe("connected");
    expect(result.fileId).toBe("file-netflix");
    expect(result.confidence).toBeGreaterThanOrEqual(70);
    expect(deps.connectFileToTransaction).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "u1",
        transactionId: "tx-1",
        fileId: "file-netflix",
      })
    );
  });

  it("ignores soft-deleted local files", async () => {
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
    store.setDoc(
      "files",
      "deleted-file",
      createTestFile({
        userId: "u1",
        fileName: "netflix_invoice.pdf",
        extractedPartner: "Netflix",
        extractedAmount: -1999,
        deletedAt: new Date(),
      })
    );
    const deps = buildDeps();
    const result = await findReceiptForTransaction(
      { transactionId: "tx-1", userId: "u1" },
      deps
    );
    expect(result.status).toBe("no_match");
    expect(result.sourcesChecked.localFiles).toBe(0);
  });

  it("returns needs_review when two strong candidates score close together", async () => {
    store.setDoc(
      "transactions",
      "tx-1",
      createTestTransaction({
        userId: "u1",
        amount: -4999,
        partner: "Spusu",
        name: "SPUSU AT",
        date: new Date("2026-02-02"),
      })
    );
    store.setDoc(
      "files",
      "file-a",
      createTestFile({
        userId: "u1",
        fileName: "spusu_rechnung_feb.pdf",
        extractedPartner: "Spusu",
        extractedAmount: -4999,
        extractedDate: new Date("2026-02-02"),
      })
    );
    store.setDoc(
      "files",
      "file-b",
      createTestFile({
        userId: "u1",
        fileName: "spusu_invoice_february.pdf",
        extractedPartner: "Spusu",
        extractedAmount: -4999,
        extractedDate: new Date("2026-02-03"),
      })
    );
    const deps = buildDeps();
    const result = await findReceiptForTransaction(
      { transactionId: "tx-1", userId: "u1" },
      deps
    );
    expect(result.status).toBe("needs_review");
    expect(result.candidates).toBeDefined();
    expect(result.candidates!.length).toBeGreaterThanOrEqual(2);
    expect(deps.connectFileToTransaction).not.toHaveBeenCalled();
  });

  it("only inspects files owned by the requesting user", async () => {
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
    store.setDoc(
      "files",
      "other-user-file",
      createTestFile({
        userId: "other-user",
        fileName: "netflix_invoice.pdf",
        extractedPartner: "Netflix",
        extractedAmount: -1999,
      })
    );
    const deps = buildDeps();
    const result = await findReceiptForTransaction(
      { transactionId: "tx-1", userId: "u1" },
      deps
    );
    expect(result.sourcesChecked.localFiles).toBe(0);
    expect(result.status).toBe("no_match");
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
    // Workflow now fires one Gmail call per typed-suggestion query in
    // parallel (matches the old wand recipe). Assert at least one call
    // included a netflix-containing query.
    expect(searchGmail).toHaveBeenCalled();
    expect(searchGmail.mock.calls.length).toBeGreaterThan(0);
    const netflixCall = searchGmail.mock.calls.find(([args]) =>
      typeof args?.query === "string" && /netflix/i.test(args.query),
    );
    expect(netflixCall).toBeDefined();
    expect(netflixCall![0]).toMatchObject({
      userId: "u1",
      integrationIds: ["int-1"],
    });
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
});
