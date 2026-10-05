/**
 * Tool handler tests: files: listing, connecting, extraction, classification and suggestions.
 *
 * One of four files split from the former handlers.test.ts by area; shared
 * mocks and setup live in handlers-harness.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { store, createTestTransaction, createTestFile } from "../../test/setup";
import { userId, otherUserId } from "./handlers-harness";

// vi.mock is hoisted per file, so the factories are imported inside it.
const extraction = vi.hoisted(() => ({ runExtraction: vi.fn() }));
vi.mock("firebase-admin/firestore", async () => (await import("./handlers-harness")).firestoreMock());
vi.mock("../../extraction/extractionCore", async () =>
  (await import("./handlers-harness")).extractionCoreMock(extraction),
);
vi.mock("firebase-functions/params", async () => (await import("./handlers-harness")).paramsMock());

// Import handlers after mocking
const handlers = await import("../handlers");

describe("Tool Registry Handlers: Files", () => {
  beforeEach(() => {
    store.clear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("listFiles", () => {
    it("should return files for user", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId }));
      store.setDoc("files", "f-2", createTestFile({ userId }));
      store.setDoc("files", "f-3", createTestFile({ userId: otherUserId }));

      const result = await handlers.listFiles(userId, {});

      expect(result.files).toHaveLength(2);
      expect(result.count).toBe(2);
      expect(result.nextCursor).toBeNull();
    });

    it("should exclude deleted files", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId }));
      store.setDoc("files", "f-2", createTestFile({ userId, deletedAt: new Date() }));

      const result = await handlers.listFiles(userId, {});

      expect(result.files).toHaveLength(1);
    });

    it("should filter by hasConnections", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, transactionIds: ["tx-1"] }));
      store.setDoc("files", "f-2", createTestFile({ userId, transactionIds: [] }));

      const connected = await handlers.listFiles(userId, { hasConnections: true });
      const unconnected = await handlers.listFiles(userId, { hasConnections: false });

      expect(connected.files).toHaveLength(1);
      expect(unconnected.files).toHaveLength(1);
    });

    it("filters to the hand-corrected population, and away from it", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({ userId, extractionCorrectedFields: { vatPercent: new Date() } })
      );
      store.setDoc("files", "f-2", createTestFile({ userId }));

      const corrected = await handlers.listFiles(userId, { handCorrected: true });
      const untouched = await handlers.listFiles(userId, { handCorrected: false });

      expect(corrected.files.map((f) => f.id)).toEqual(["f-1"]);
      expect(untouched.files.map((f) => f.id)).toEqual(["f-2"]);
    });
  });

  describe("listFiles - paging and the limit (#116)", () => {
    // Seed n files, newest first by uploadedAt so page order is deterministic.
    const seedFiles = (n: number, overridesFor: (i: number) => Record<string, unknown> = () => ({})) => {
      for (let i = 0; i < n; i++) {
        store.setDoc(
          "files",
          `f-${String(i).padStart(3, "0")}`,
          createTestFile({
            userId,
            uploadedAt: new Date(Date.UTC(2026, 0, 1) + (n - i) * 60_000),
            ...overridesFor(i),
          })
        );
      }
    };

    it("honours a limit above 100 instead of silently clamping to it", async () => {
      seedFiles(120);

      const result = await handlers.listFiles(userId, { limit: 200 });

      expect(result.count).toBe(120);
      expect(result.files).toHaveLength(120);
    });

    it("caps the page at 500 for an absurd limit, and says there is more", async () => {
      seedFiles(600);

      const result = await handlers.listFiles(userId, { limit: 10_000 });

      expect(result.count).toBe(500);
      expect(result.nextCursor).not.toBeNull();
    });

    it("does not report an empty account when the newest documents are all filtered away", async () => {
      // The headline bug: the pre-fix handler read the newest `limit`
      // documents and dropped the soft-deleted and not-an-invoice ones after
      // that, so an account whose newest 100 are all filtered came back as [],
      // which reads to an agent as "this account has no files".
      seedFiles(120, (i) => (i < 100 ? { deletedAt: new Date() } : {}));

      const result = await handlers.listFiles(userId, { limit: 50 });

      expect(result.count).toBe(20);
      expect(result.files.every((f) => !f.deletedAt)).toBe(true);
    });

    it("reaches files past the newest 100 documents", async () => {
      // Anything older than the newest 100 by uploadedAt was unreachable
      // through the tool at all: the cap was hard and there was no cursor.
      seedFiles(250);

      const seen = new Set<string>();
      let cursor: string | null | undefined = undefined;
      let guard = 0;

      do {
        const page: Awaited<ReturnType<typeof handlers.listFiles>> = await handlers.listFiles(userId, {
          limit: 50,
          ...(cursor ? { cursor } : {}),
        });
        page.files.forEach((f) => seen.add(f.id as string));
        cursor = page.nextCursor;
      } while (cursor && ++guard < 20);

      expect(seen.size).toBe(250);
      expect(seen.has("f-249")).toBe(true);
    });

    it("pages to exhaustion via nextCursor, no duplicates, no gaps", async () => {
      seedFiles(25);

      const seen: string[] = [];
      let cursor: string | null | undefined = undefined;
      let guard = 0;

      do {
        const page: Awaited<ReturnType<typeof handlers.listFiles>> = await handlers.listFiles(userId, {
          limit: 7,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...page.files.map((f) => f.id as string));
        cursor = page.nextCursor;
      } while (cursor && ++guard < 20);

      expect(seen).toHaveLength(25);
      expect(new Set(seen).size).toBe(25);
    });

    it("keeps paging when a whole scan window is filtered away", async () => {
      // 60 not-an-invoice files in front of 5 real ones, page size 5 -> scan
      // window 25, so the first two pages are empty but must still hand back a
      // cursor rather than ending the walk.
      seedFiles(65, (i) => (i < 60 ? { isNotInvoice: true } : {}));

      const seen: string[] = [];
      let cursor: string | null | undefined = undefined;
      let guard = 0;

      do {
        const page: Awaited<ReturnType<typeof handlers.listFiles>> = await handlers.listFiles(userId, {
          limit: 5,
          ...(cursor ? { cursor } : {}),
        });
        seen.push(...page.files.map((f) => f.id as string));
        cursor = page.nextCursor;
      } while (cursor && ++guard < 30);

      expect(seen).toHaveLength(5);
    });

    it("ignores a cursor belonging to another user", async () => {
      seedFiles(3);
      store.setDoc("files", "f-other", createTestFile({ userId: otherUserId }));

      const result = await handlers.listFiles(userId, { cursor: "f-other" });

      expect(result.count).toBe(3);
    });

    it("ignores a cursor that does not exist", async () => {
      seedFiles(3);

      const result = await handlers.listFiles(userId, { cursor: "f-gone" });

      expect(result.count).toBe(3);
    });
  });

  describe("startAfterCursor (#116)", () => {
    // A stand-in for the query being built: it only has to record whether the
    // cursor was applied, and to whom.
    const spyQuery = () => {
      const calls: Array<{ id: string }> = [];
      const query = {
        startAfter: (snap: { id: string }) => {
          calls.push({ id: snap.id });
          return query;
        },
      };
      return { query, calls };
    };

    it("resumes after a cursor document the caller owns", async () => {
      store.setDoc("files", "f-own", createTestFile({ userId }));
      const { query, calls } = spyQuery();

      await handlers.startAfterCursor(
        query as unknown as FirebaseFirestore.Query,
        "files",
        userId,
        "f-own"
      );

      expect(calls.map((c) => c.id)).toEqual(["f-own"]);
    });

    it("refuses a cursor document belonging to another user", async () => {
      // The leak this guards: a caller holding or guessing another user's
      // document id would otherwise resume paging from a position inside that
      // user's data.
      store.setDoc("files", "f-other", createTestFile({ userId: otherUserId }));
      const { query, calls } = spyQuery();

      const result = await handlers.startAfterCursor(
        query as unknown as FirebaseFirestore.Query,
        "files",
        userId,
        "f-other"
      );

      expect(calls).toHaveLength(0);
      expect(result).toBe(query);
    });

    it("ignores a cursor that does not exist, and a cursor that is not a string", async () => {
      const missing = spyQuery();
      await handlers.startAfterCursor(
        missing.query as unknown as FirebaseFirestore.Query,
        "files",
        userId,
        "f-gone"
      );
      expect(missing.calls).toHaveLength(0);

      for (const cursor of [undefined, null, "", 42, { id: "f-1" }]) {
        const { query, calls } = spyQuery();
        await handlers.startAfterCursor(
          query as unknown as FirebaseFirestore.Query,
          "files",
          userId,
          cursor
        );
        expect(calls).toHaveLength(0);
      }
    });

    it("guards the transactions listings the same way", async () => {
      store.setDoc("transactions", "tx-other", createTestTransaction({ userId: otherUserId }));
      const { query, calls } = spyQuery();

      await handlers.startAfterCursor(
        query as unknown as FirebaseFirestore.Query,
        "transactions",
        userId,
        "tx-other"
      );

      expect(calls).toHaveLength(0);
    });
  });

  describe("getFile", () => {
    it("should return file by ID", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, fileName: "invoice.pdf" }));

      const result = await handlers.getFile(userId, "f-1");

      expect(result.id).toBe("f-1");
      expect(result.fileName).toBe("invoice.pdf");
    });

    it("should throw error for non-existent file", async () => {
      await expect(handlers.getFile(userId, "non-existent")).rejects.toThrow("File not found");
    });
  });

  describe("updateFileExtraction", () => {
    it("corrects only what was passed and makes the human the authority", async () => {
      // A Schlussrechnung due 3180.00 whose items describe the
      // full 6360.00 scope, flagged and carrying a printed rate-group block.
      store.setDoc(
        "files",
        "f-1",
        createTestFile({
          userId,
          extractedAmount: 636000,
          extractedVatAmount: 106000,
          extractedVatPercent: 20,
          extractedPartner: "ELDI Handels GmbH",
          lineItemsUnreconciled: true,
          extractedRateGroups: [{ rate: 20, net: 530000, vat: 106000, gross: 636000 }],
        })
      );

      const result = await handlers.updateFileExtraction(userId, {
        fileId: "f-1",
        amount: 318000,
        vatAmount: 53000,
      });

      expect(result).toMatchObject({ success: true, fileId: "f-1", changed: ["amount", "vatAmount"] });

      const file = store.getDoc("files", "f-1");
      expect(file?.extractedAmount).toBe(318000);
      expect(file?.extractedVatAmount).toBe(53000);
      // Untouched by this correction.
      expect(file?.extractedVatPercent).toBe(20);
      expect(file?.extractedPartner).toBe("ELDI Handels GmbH");
      // The artefacts that would outrank the correction are gone.
      expect(file?.lineItemsUnreconciled).toBe(false);
      expect(file?.extractedRateGroups).toBeNull();
      expect(file?.vatSourceDowngraded).toBe(false);
    });

    it("recomputes the § 11 document type, since it is stored and not read-time (#104)", async () => {
      // Under 400 EUR with a rate: a valid Kleinbetragsrechnung.
      store.setDoc(
        "files",
        "f-1",
        createTestFile({
          userId,
          extractedAmount: 5400,
          extractedVatPercent: 20,
          extractedDate: new Date("2026-03-04"),
          extractedPartner: "Elektro Huber e.U.",
          extractedAddress: "Wien",
          extractedLineItems: [{ description: "USB-C Kabel", vatPercent: 20 }],
          extractedSelfDesignation: "Rechnung",
          extractedInvoiceNumber: null,
          documentType: "invoice",
        })
      );

      // Clearing the rate takes the § 11 Abs 6 discriminator away with it.
      await handlers.updateFileExtraction(userId, { fileId: "f-1", vatPercent: null, lineItems: [] });

      const file = store.getDoc("files", "f-1");
      expect(file?.documentType).toBe("receipt");
      expect(file?.documentTypeMissingElements).toContain("steuersatz");
    });

    it("propagates a changed document type to the transactions holding the file (#104)", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({
          userId,
          extractedAmount: 5400,
          extractedVatPercent: 20,
          documentType: "receipt",
          transactionIds: ["tx-1"],
        })
      );
      store.setDoc(
        "transactions",
        "tx-1",
        createTestTransaction({ userId, fileIds: ["f-1"], documentationState: "receipt-only" })
      );

      // A rate at this amount makes it a Kleinbetragsrechnung.
      await handlers.updateFileExtraction(userId, { fileId: "f-1", vatPercent: 20 });

      expect(store.getDoc("files", "f-1")?.documentType).toBe("invoice");
      expect(store.getDoc("transactions", "tx-1")?.documentationState).toBe("invoice");
    });

    it("writes a zero rate rather than reading it as unset", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, extractedVatPercent: 20, extractedVatAmount: 4533 }));

      await handlers.updateFileExtraction(userId, { fileId: "f-1", vatPercent: 0, vatAmount: 0 });

      const file = store.getDoc("files", "f-1");
      expect(file?.extractedVatPercent).toBe(0);
      expect(file?.extractedVatAmount).toBe(0);
    });

    it("refuses a file the caller does not own", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId: "someone-else" }));

      await expect(
        handlers.updateFileExtraction(userId, { fileId: "f-1", amount: 1 })
      ).rejects.toThrow("File not found");
    });

    it("refuses a correction that corrects nothing", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId }));

      await expect(handlers.updateFileExtraction(userId, { fileId: "f-1" })).rejects.toThrow(
        /Nothing to correct/
      );
    });

    it("records a Trinkgeld the document never printed, beside the total (#217)", async () => {
      // The agent's door onto the same field the panel writes. The Beleg is
      // § 11-complete over 50,80 with its rate groups printed; the card was
      // charged 54,00 because the terminal took a tip the receipt omits.
      store.setDoc(
        "files",
        "f-1",
        createTestFile({
          userId,
          extractedAmount: 5080,
          extractedTipAmount: null,
          extractedRateGroups: [
            { rate: 10, net: 3500, vat: 350, gross: 3850 },
            { rate: 20, net: 1025, vat: 205, gross: 1230 },
          ],
        })
      );

      const result = await handlers.updateFileExtraction(userId, {
        fileId: "f-1",
        tipAmount: 320,
      });

      expect(result).toMatchObject({ success: true, changed: ["tipAmount"] });

      const file = store.getDoc("files", "f-1");
      expect(file?.extractedTipAmount).toBe(320);
      // Never subtracted: this total never included the tip, so taking it out
      // would shrink the VAT base and under-claim.
      expect(file?.extractedAmount).toBe(5080);
      // A tip is outside the scope of VAT, so it says nothing against the
      // printed block — which stays.
      expect(file?.extractedRateGroups).toHaveLength(2);
      expect(Object.keys(file?.extractionCorrectedFields as object)).toEqual(["tipAmount"]);
    });

    it("refuses a negative tip", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, extractedAmount: 5080 }));

      await expect(
        handlers.updateFileExtraction(userId, { fileId: "f-1", tipAmount: -320 })
      ).rejects.toThrow(/must not be negative/);
    });

    it("scores the hand-set tip onto its bank line, as the panel does (#217)", async () => {
      // score_file_transaction_match is the agent's copy of the question the
      // detail panel asks, and both have to answer it the same way: the card
      // was charged Summe + Trinkgeld, so once a person records the tip the
      // pair is an exact amount match rather than a 3,20 overpay.
      store.setDoc(
        "files",
        "f-1",
        createTestFile({
          userId,
          extractedAmount: 5080,
          extractedTipAmount: null,
          extractedCurrency: "EUR",
          extractedDate: { toDate: () => new Date("2026-02-20T00:00:00Z") },
          extractedPartner: "Gasthaus Zur Post",
        })
      );
      store.setDoc(
        "transactions",
        "tx-1",
        createTestTransaction({
          userId,
          amount: -5400,
          date: { toDate: () => new Date("2026-02-20T00:00:00Z") },
          currency: "EUR",
          name: "GASTHAUS ZUR POST WIEN",
        })
      );

      const before = await handlers.scoreFileTransactionMatch(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
      });
      expect(before.matchSources).not.toContain("amount_exact");

      await handlers.updateFileExtraction(userId, { fileId: "f-1", tipAmount: 320 });

      const after = await handlers.scoreFileTransactionMatch(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
      });
      expect(after.matchSources).toContain("amount_exact");
    });

    it("ignores a key the schema does not name", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, extractedPartner: "ELDI Handels GmbH" }));

      await handlers.updateFileExtraction(userId, {
        fileId: "f-1",
        amount: 318000,
        extractedPartner: "Somebody Else",
      });

      expect(store.getDoc("files", "f-1")?.extractedPartner).toBe("ELDI Handels GmbH");
    });
  });

  describe("updateFileExtraction — setting the direction by hand (#233)", () => {
    it("stores a direction a person set, and stamps it as their work", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, invoiceDirection: "unknown" }));

      const result = await handlers.updateFileExtraction(userId, {
        fileId: "f-1",
        invoiceDirection: "incoming",
      });

      expect(result).toMatchObject({ changed: ["invoiceDirection"] });
      const file = store.getDoc("files", "f-1");
      expect(file?.invoiceDirection).toBe("incoming");
      // #184: a re-extraction must not quietly undo it.
      expect(Object.keys(file?.extractionCorrectedFields as object)).toContain("invoiceDirection");
    });

    it("refuses a direction that is not one of the three", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId }));

      await expect(
        handlers.updateFileExtraction(userId, { fileId: "f-1", invoiceDirection: "sideways" })
      ).rejects.toThrow(/invoiceDirection must be one of/);
    });

    it("clears the review flag once the direction agrees with the linked transaction", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, amount: -12000 }));
      store.setDoc(
        "files",
        "f-1",
        createTestFile({
          userId,
          extractionComplete: true,
          transactionIds: ["tx-1"],
          invoiceDirection: "outgoing",
          needsDirectionReview: true,
          directionReviewReason: "conflict",
          directionConflictTransactionIds: ["tx-1"],
        })
      );

      await handlers.updateFileExtraction(userId, {
        fileId: "f-1",
        invoiceDirection: "incoming",
      });

      const file = store.getDoc("files", "f-1");
      expect(file?.needsDirectionReview).toBe(false);
      expect(file?.directionReviewReason).toBeNull();
      expect(file?.directionConflictTransactionIds).toEqual([]);
    });

    it("raises the flag when the correction puts the file at odds with its transaction", async () => {
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, amount: -12000 }));
      store.setDoc(
        "files",
        "f-1",
        createTestFile({
          userId,
          extractionComplete: true,
          transactionIds: ["tx-1"],
          invoiceDirection: "incoming",
        })
      );

      await handlers.updateFileExtraction(userId, {
        fileId: "f-1",
        invoiceDirection: "outgoing",
      });

      const file = store.getDoc("files", "f-1");
      expect(file?.needsDirectionReview).toBe(true);
      expect(file?.directionReviewReason).toBe("conflict");
      expect(file?.directionSuggested).toBe("incoming");
    });
  });

  describe("listFiles — the review lists (#229, #233)", () => {
    it("returns only the files addressed to somebody else when asked", async () => {
      store.setDoc("files", "f-foreign", createTestFile({ userId, foreignRecipient: true }));
      store.setDoc("files", "f-mine", createTestFile({ userId, foreignRecipient: false }));
      store.setDoc("files", "f-legacy", createTestFile({ userId }));

      const flagged = await handlers.listFiles(userId, { foreignRecipient: true });
      expect(flagged.files.map((f) => f.id)).toEqual(["f-foreign"]);

      // A record written before the rule is not "addressed to somebody else".
      const rest = await handlers.listFiles(userId, { foreignRecipient: false });
      expect(rest.files.map((f) => f.id).sort()).toEqual(["f-legacy", "f-mine"]);
    });

    it("returns the direction review list when asked", async () => {
      store.setDoc("files", "f-flagged", createTestFile({ userId, needsDirectionReview: true }));
      store.setDoc("files", "f-clear", createTestFile({ userId, needsDirectionReview: false }));

      const flagged = await handlers.listFiles(userId, { needsDirectionReview: true });
      expect(flagged.files.map((f) => f.id)).toEqual(["f-flagged"]);
    });
  });

  describe("confirmFileRecipientIsUser / unconfirmFileRecipientIsUser (#229)", () => {
    /** § 11-perfect, addressed to somebody the identity data does not know. */
    const thirdPartyInvoice = () =>
      createTestFile({
        userId,
        extractionComplete: true,
        extractedAmount: 48000,
        extractedVatPercent: 20,
        extractedVatAmount: 8000,
        extractedLineItems: [{ description: "Monitor", vatPercent: 20 }],
        extractedIssuer: { name: "Fernhandel S.à r.l.", address: "L-2338", vatId: "LU12345678" },
        extractedRecipient: { name: "Maria Musterfrau", address: "Musterweg 4, 4020 Linz" },
        extractedDate: new Date("2026-05-14"),
        extractedSelfDesignation: "Rechnung",
        extractedInvoiceNumber: "2026-0771",
        recipientIdentityMatch: "third-party",
        documentType: "invoice",
        foreignRecipient: true,
      });

    it("lifts the block and reclassifies the file in the same write", async () => {
      store.setDoc("files", "f-1", thirdPartyInvoice());

      const result = await handlers.confirmFileRecipientIsUser(userId, { fileId: "f-1" });

      expect(result).toMatchObject({ success: true, foreignRecipient: false });
      const file = store.getDoc("files", "f-1");
      expect(file?.recipientConfirmedAsUser).toBe(true);
      expect(file?.foreignRecipient).toBe(false);
      expect(file?.documentType).toBe("invoice");
      expect((file?.documentTypeBasis as Record<string, unknown>)?.reason).toBe(
        "section-11-satisfied"
      );
    });

    it("puts the block back when the confirmation is withdrawn", async () => {
      store.setDoc(
        "files",
        "f-1",
        { ...thirdPartyInvoice(), recipientConfirmedAsUser: true, foreignRecipient: false }
      );

      const result = await handlers.unconfirmFileRecipientIsUser(userId, { fileId: "f-1" });

      expect(result).toMatchObject({ success: true, foreignRecipient: true });
      const file = store.getDoc("files", "f-1");
      expect(file?.recipientConfirmedAsUser).toBe(false);
      expect(file?.foreignRecipient).toBe(true);
      expect((file?.documentTypeBasis as Record<string, unknown>)?.reason).toBe(
        "foreign-recipient"
      );
    });

    it("refuses another user's file", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId: otherUserId }));

      await expect(
        handlers.confirmFileRecipientIsUser(userId, { fileId: "f-1" })
      ).rejects.toThrow("File not found");
    });
  });

  describe("reclassifyDocumentsTool", () => {
    /** A payment confirmation: no rate, no UID, and it says what it is. */
    function receiptFile() {
      return createTestFile({
        userId,
        extractedAmount: 2499,
        extractedDate: new Date("2026-03-05"),
        extractedIssuer: { name: "Amazon EU S.à r.l.", address: "Luxembourg", vatId: null },
        extractedSelfDesignation: "Zahlungsbestätigung",
        extractedInvoiceNumber: null,
      });
    }

    it("defaults to a dry run when dispatched with no arguments", async () => {
      store.setDoc("files", "f-1", receiptFile());
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, fileIds: ["f-1"] }));

      const result = (await handlers.handleTool(userId, "reclassify_documents", {})) as {
        dryRun: boolean;
        files: { changed: number; written: number };
        transactions: { changed: number; written: number };
      };

      expect(result.dryRun).toBe(true);
      expect(result.files).toMatchObject({ changed: 1, written: 0 });
      expect(result.transactions).toMatchObject({ changed: 1, written: 0 });
      expect(store.getDoc("files", "f-1")?.documentType).toBeUndefined();
    });

    it("classifies files and re-derives transactions in one call when opted in", async () => {
      store.setDoc("files", "f-1", receiptFile());
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, fileIds: ["f-1"] }));

      await handlers.reclassifyDocumentsTool(userId, { dryRun: false });

      expect(store.getDoc("files", "f-1")?.documentType).toBe("receipt");
      expect(store.getDoc("transactions", "tx-1")?.documentationState).toBe("receipt-only");
    });

    it("refuses a dryRun that is not a boolean", async () => {
      await expect(
        handlers.reclassifyDocumentsTool(userId, { dryRun: "false" })
      ).rejects.toThrow("dryRun must be a boolean");
    });
  });

  describe("markFileAsNotInvoice / unmarkFileAsNotInvoice", () => {
    it("should flag the file, clear extracted data and empty the suggestion queue", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({
          userId,
          transactionIds: [],
          isNotInvoice: false,
          extractedAmount: 1999,
          extractedIssuer: "Anthropic, PBC",
          extractionConfidence: 92,
          transactionMatchComplete: true,
          transactionSuggestions: [{ transactionId: "tx-1", confidence: 91 }],
        })
      );

      const result = await handlers.markFileAsNotInvoice(userId, {
        fileId: "f-1",
        reason: "duplicate re-send",
      });

      expect(result).toMatchObject({ success: true, fileId: "f-1", isNotInvoice: true });

      const file = store.getDoc("files", "f-1");
      expect(file?.isNotInvoice).toBe(true);
      expect(file?.notInvoiceReason).toBe("duplicate re-send");
      expect(file?.extractedAmount).toBeNull();
      expect(file?.extractionConfidence).toBeNull();
      expect(file?.transactionSuggestions).toEqual([]);
      expect(file?.transactionMatchComplete).toBe(false);
      // Nothing left to extract, so extraction counts as done.
      expect(file?.extractionComplete).toBe(true);
    });

    it("clears the repaired-escape flag along with the values it pointed at (#275)", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({
          userId,
          transactionIds: [],
          extractedAddress: "C:\\Users\ttest",
          needsRepairReview: true,
          repairAmbiguousFields: ["address"],
        })
      );

      await handlers.markFileAsNotInvoice(userId, { fileId: "f-1" });

      // The transcription the flag doubted is gone, so a warning naming a
      // field this file no longer has would only mislead.
      const file = store.getDoc("files", "f-1");
      expect(file?.extractedAddress).toBeNull();
      expect(file?.needsRepairReview).toBe(false);
      expect(file?.repairAmbiguousFields).toEqual([]);
    });

    it("should default the reason when none is given", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, transactionIds: [] }));

      await handlers.markFileAsNotInvoice(userId, { fileId: "f-1" });

      expect(store.getDoc("files", "f-1")?.notInvoiceReason).toBe("Marked by user");
    });

    it("should preserve a manually-set partner", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({
          userId,
          transactionIds: [],
          partnerId: "p-1",
          partnerMatchedBy: "manual",
        })
      );

      await handlers.markFileAsNotInvoice(userId, { fileId: "f-1" });

      const file = store.getDoc("files", "f-1");
      expect(file?.partnerId).toBe("p-1");
      expect(file?.partnerMatchedBy).toBe("manual");
    });

    it("should clear an auto-matched partner", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({ userId, transactionIds: [], partnerId: "p-1", partnerMatchedBy: "auto" })
      );

      await handlers.markFileAsNotInvoice(userId, { fileId: "f-1" });

      expect(store.getDoc("files", "f-1")?.partnerId).toBeNull();
    });

    it("should refuse while the file is still connected to a transaction", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, transactionIds: ["tx-1"] }));

      await expect(handlers.markFileAsNotInvoice(userId, { fileId: "f-1" })).rejects.toThrow(
        /connected to 1 transaction/
      );

      // The refusal must not have written anything.
      expect(store.getDoc("files", "f-1")?.isNotInvoice).toBeFalsy();
    });

    it("should require a fileId", async () => {
      await expect(handlers.markFileAsNotInvoice(userId, {})).rejects.toThrow("fileId is required");
      await expect(handlers.unmarkFileAsNotInvoice(userId, {})).rejects.toThrow("fileId is required");
    });

    it("should not reach another user's file", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId: otherUserId, transactionIds: [] }));

      await expect(handlers.markFileAsNotInvoice(userId, { fileId: "f-1" })).rejects.toThrow("File not found");
      await expect(handlers.unmarkFileAsNotInvoice(userId, { fileId: "f-1" })).rejects.toThrow("File not found");
    });

    it("should re-open extraction on unmark, and queue it without re-classifying", async () => {
      extraction.runExtraction.mockReset();
      store.setDoc(
        "files",
        "f-1",
        createTestFile({
          userId,
          isNotInvoice: true,
          notInvoiceReason: "duplicate re-send",
          extractionComplete: true,
        })
      );

      const result = await handlers.unmarkFileAsNotInvoice(userId, { fileId: "f-1" });

      expect(result).toMatchObject({ success: true, isNotInvoice: false });
      // Nothing fires on the write, so the tool queues the Extraction itself
      // (this build runs the queue inline). The user ruled it an invoice.
      expect(extraction.runExtraction).toHaveBeenCalledTimes(1);
      expect(extraction.runExtraction).toHaveBeenCalledWith("f-1", expect.anything(), {
        skipClassification: true,
        overwriteCorrections: false,
      });

      const file = store.getDoc("files", "f-1");
      expect(file?.isNotInvoice).toBe(false);
      expect(file?.notInvoiceReason).toBeNull();
      expect(file?.extractionComplete).toBe(false);
      expect(file?.transactionMatchComplete).toBe(false);
    });

    it("should leave transaction matching alone when a manual connection exists", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({ userId, isNotInvoice: true, transactionMatchComplete: true })
      );
      store.setDoc("fileConnections", "conn-1", {
        fileId: "f-1",
        transactionId: "tx-1",
        userId,
        connectionType: "manual",
      });

      await handlers.unmarkFileAsNotInvoice(userId, { fileId: "f-1" });

      const file = store.getDoc("files", "f-1");
      expect(file?.isNotInvoice).toBe(false);
      // Re-running the match would discard a connection a human made by hand.
      expect(file?.transactionMatchComplete).toBe(true);
    });

    it("should round-trip mark then unmark", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, transactionIds: [], extractedAmount: 1999 }));

      await handlers.markFileAsNotInvoice(userId, { fileId: "f-1", reason: "statement" });
      expect(store.getDoc("files", "f-1")?.isNotInvoice).toBe(true);

      await handlers.unmarkFileAsNotInvoice(userId, { fileId: "f-1" });

      const file = store.getDoc("files", "f-1");
      expect(file?.isNotInvoice).toBe(false);
      expect(file?.notInvoiceReason).toBeNull();
      // The cleared fields come back via re-extraction, which this re-opens.
      expect(file?.extractionComplete).toBe(false);
    });
  });

  describe("markFileVatNotClaimable / unmarkFileVatNotClaimable", () => {
    it("stores the reason and leaves the extracted figures alone", async () => {
      // f-insurance-11pct: 11% Versicherungssteuer, printed rate-group block.
      store.setDoc(
        "files",
        "f-1",
        createTestFile({
          userId,
          transactionIds: ["tx-1"],
          extractedAmount: 22200,
          extractedRateGroups: [{ rate: 11, net: 20000, vat: 2200, gross: 22200 }],
        })
      );

      const result = await handlers.markFileVatNotClaimable(userId, {
        fileId: "f-1",
        reason: "insurance-tax",
        note: "Filmproduktionshaftpflicht",
      });

      expect(result).toMatchObject({
        success: true,
        fileId: "f-1",
        vatNotClaimableReason: "insurance-tax",
      });

      const file = store.getDoc("files", "f-1");
      expect(file?.vatNotClaimableReason).toBe("insurance-tax");
      expect(file?.vatNotClaimableNote).toBe("Filmproduktionshaftpflicht");
      expect(file?.extractedAmount).toBe(22200);
      expect(file?.extractedRateGroups).toEqual([
        { rate: 11, net: 20000, vat: 2200, gross: 22200 },
      ]);
    });

    it("refuses a reason outside the closed set", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId }));

      await expect(
        handlers.markFileVatNotClaimable(userId, { fileId: "f-1", reason: "because" })
      ).rejects.toThrow(/insurance-tax/);
      expect(store.getDoc("files", "f-1")?.vatNotClaimableReason).toBeUndefined();
    });

    it("marks a connected file — that is the case it exists for", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, transactionIds: ["tx-1"] }));

      await handlers.markFileVatNotClaimable(userId, {
        fileId: "f-1",
        reason: "discount-to-zero",
      });

      expect(store.getDoc("files", "f-1")?.vatNotClaimableReason).toBe("discount-to-zero");
    });

    it("round-trips mark then unmark", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, extractedVatAmount: 2000 }));

      await handlers.markFileVatNotClaimable(userId, { fileId: "f-1", reason: "private" });
      await handlers.unmarkFileVatNotClaimable(userId, { fileId: "f-1" });

      const file = store.getDoc("files", "f-1");
      expect(file?.vatNotClaimableReason).toBeNull();
      expect(file?.vatNotClaimableNote).toBeNull();
      // Nothing was ever cleared, so nothing has to come back.
      expect(file?.extractedVatAmount).toBe(2000);
    });

    it("refuses a file that is not the caller's", async () => {
      store.setDoc("files", "f-other", createTestFile({ userId: otherUserId }));

      await expect(
        handlers.markFileVatNotClaimable(userId, { fileId: "f-other", reason: "levy" })
      ).rejects.toThrow("File not found");
    });
  });

  describe("autoConnectFileSuggestions", () => {
    it("should auto-connect files with high confidence suggestions", async () => {
      store.setDoc("files", "f-1", createTestFile({
        userId,
        transactionIds: [],
        transactionMatchComplete: true,
        transactionSuggestions: [
          { transactionId: "tx-1", confidence: 95 },
          { transactionId: "tx-2", confidence: 70 },
        ],
      }));
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId, fileIds: [] }));
      store.setDoc("transactions", "tx-2", createTestTransaction({ userId, fileIds: [] }));

      const result = await handlers.autoConnectFileSuggestions(userId, { minConfidence: 89 });

      expect(result.connected).toBe(1);
      expect(result.skipped).toBe(0);
      expect(result.connections).toHaveLength(1);
      expect(result.connections[0].transactionId).toBe("tx-1");
      expect(result.connections[0].confidence).toBe(95);
    });

    it("should skip files below confidence threshold", async () => {
      // When using fileId, it processes that specific file regardless of transactionMatchComplete
      store.setDoc("files", "f-1", createTestFile({
        userId,
        transactionIds: [],
        transactionSuggestions: [{ transactionId: "tx-1", confidence: 50 }],
      }));

      const result = await handlers.autoConnectFileSuggestions(userId, { fileId: "f-1", minConfidence: 89 });

      expect(result.connected).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it("should skip already connected files", async () => {
      store.setDoc("files", "f-1", createTestFile({
        userId,
        transactionIds: ["tx-existing"],
        transactionSuggestions: [{ transactionId: "tx-1", confidence: 95 }],
      }));

      // Using fileId to target specific file
      const result = await handlers.autoConnectFileSuggestions(userId, { fileId: "f-1" });

      expect(result.connected).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it("should process specific file when fileId provided", async () => {
      store.setDoc("files", "f-1", createTestFile({
        userId,
        transactionIds: [],
        transactionSuggestions: [{ transactionId: "tx-1", confidence: 95 }],
      }));
      store.setDoc("files", "f-2", createTestFile({
        userId,
        transactionIds: [],
        transactionSuggestions: [{ transactionId: "tx-2", confidence: 95 }],
      }));
      store.setDoc("transactions", "tx-1", createTestTransaction({ userId }));

      const result = await handlers.autoConnectFileSuggestions(userId, { fileId: "f-1" });

      expect(result.connected).toBe(1);
      expect(result.connections[0].fileId).toBe("f-1");
    });

    it("should throw error for non-existent fileId", async () => {
      await expect(
        handlers.autoConnectFileSuggestions(userId, { fileId: "non-existent" })
      ).rejects.toThrow("File not found");
    });

    it("should use default confidence of 89 when not specified", async () => {
      store.setDoc("files", "f-1", createTestFile({
        userId,
        transactionIds: [],
        transactionSuggestions: [{ transactionId: "tx-1", confidence: 88 }],
      }));

      // Using fileId to target specific file
      const result = await handlers.autoConnectFileSuggestions(userId, { fileId: "f-1" });

      expect(result.connected).toBe(0);
      expect(result.skipped).toBe(1);
    });

    it("should connect to highest confidence suggestion", async () => {
      store.setDoc("files", "f-1", createTestFile({
        userId,
        transactionIds: [],
        transactionMatchComplete: true,
        transactionSuggestions: [
          { transactionId: "tx-low", confidence: 90 },
          { transactionId: "tx-high", confidence: 98 },
          { transactionId: "tx-mid", confidence: 95 },
        ],
      }));
      store.setDoc("transactions", "tx-high", createTestTransaction({ userId }));

      const result = await handlers.autoConnectFileSuggestions(userId, {});

      expect(result.connections[0].transactionId).toBe("tx-high");
    });
  });

  describe("listFiles - VAT rate review queue", () => {
    it("filters to files printing a rate outside the Austrian set", async () => {
      store.setDoc(
        "files",
        "f-flagged",
        createTestFile({ userId, needsVatRateReview: true, vatRatesOutsideSet: [11] })
      );
      store.setDoc("files", "f-ok", createTestFile({ userId, needsVatRateReview: false }));
      // Written before the detector existed: no flag at all, not a flagged one.
      store.setDoc("files", "f-legacy", createTestFile({ userId }));

      const flagged = await handlers.listFiles(userId, { needsVatRateReview: true });
      const rest = await handlers.listFiles(userId, { needsVatRateReview: false });

      expect(flagged.files.map((f) => f.id)).toEqual(["f-flagged"]);
      expect(flagged.files[0].vatRatesOutsideSet).toEqual([11]);
      expect(rest.files.map((f) => f.id).sort()).toEqual(["f-legacy", "f-ok"]);
    });

    it("returns every file when the filter is not passed", async () => {
      store.setDoc("files", "f-flagged", createTestFile({ userId, needsVatRateReview: true }));
      store.setDoc("files", "f-ok", createTestFile({ userId }));

      expect((await handlers.listFiles(userId, {})).files).toHaveLength(2);
    });
  });

  describe("listFiles - needsRksvCodeReview (#166)", () => {
    it("lists the receipts whose printed block the RKSV Code contradicts", async () => {
      store.setDoc(
        "files",
        "f-flagged",
        createTestFile({ userId, needsRksvCodeReview: true, rksvCodeDisagreeingRates: [10, 13] })
      );
      store.setDoc("files", "f-ok", createTestFile({ userId, needsRksvCodeReview: false }));
      // Written before the detector existed: no flag at all, not a flagged one.
      store.setDoc("files", "f-legacy", createTestFile({ userId }));

      const flagged = await handlers.listFiles(userId, { needsRksvCodeReview: true });
      const rest = await handlers.listFiles(userId, { needsRksvCodeReview: false });

      expect(flagged.files.map((f) => f.id)).toEqual(["f-flagged"]);
      expect(flagged.files[0].rksvCodeDisagreeingRates).toEqual([10, 13]);
      expect(rest.files.map((f) => f.id).sort()).toEqual(["f-legacy", "f-ok"]);
    });
  });

  describe("listFiles - additional filters", () => {
    it("should filter by hasSuggestions true", async () => {
      store.setDoc("files", "f-1", createTestFile({
        userId,
        transactionSuggestions: [{ transactionId: "tx-1", confidence: 90 }],
      }));
      store.setDoc("files", "f-2", createTestFile({
        userId,
        transactionSuggestions: [],
      }));

      const result = await handlers.listFiles(userId, { hasSuggestions: true });

      expect(result.files).toHaveLength(1);
      expect(result.files[0].id).toBe("f-1");
    });

    it("should filter by hasSuggestions false", async () => {
      store.setDoc("files", "f-1", createTestFile({
        userId,
        transactionSuggestions: [{ transactionId: "tx-1", confidence: 90 }],
      }));
      store.setDoc("files", "f-2", createTestFile({
        userId,
        transactionSuggestions: [],
      }));

      const result = await handlers.listFiles(userId, { hasSuggestions: false });

      expect(result.files).toHaveLength(1);
      expect(result.files[0].id).toBe("f-2");
    });

    it("should exclude isNotInvoice files", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId }));
      store.setDoc("files", "f-2", createTestFile({ userId, isNotInvoice: true }));

      const result = await handlers.listFiles(userId, {});

      expect(result.files).toHaveLength(1);
      expect(result.files[0].id).toBe("f-1");
    });

    it("should combine multiple filters", async () => {
      store.setDoc("files", "f-1", createTestFile({
        userId,
        transactionIds: [],
        transactionSuggestions: [{ transactionId: "tx-1", confidence: 90 }],
      }));
      store.setDoc("files", "f-2", createTestFile({
        userId,
        transactionIds: ["tx-1"],
        transactionSuggestions: [{ transactionId: "tx-2", confidence: 80 }],
      }));
      store.setDoc("files", "f-3", createTestFile({
        userId,
        transactionIds: [],
        transactionSuggestions: [],
      }));

      const result = await handlers.listFiles(userId, {
        hasConnections: false,
        hasSuggestions: true,
      });

      expect(result.files).toHaveLength(1);
      expect(result.files[0].id).toBe("f-1");
    });
  });

  describe("dismissTransactionSuggestion / undismissTransactionSuggestion", () => {
    const suggestion = (transactionId: string, confidence: number) => ({
      transactionId,
      confidence,
      matchSources: [{ type: "amount", weight: 40 }],
    });

    it("should drop the suggestion, blacklist the pair and report its confidence", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({
          userId,
          transactionSuggestions: [suggestion("tx-1", 82), suggestion("tx-2", 61)],
        })
      );

      const result = await handlers.dismissTransactionSuggestion(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
        reason: "coincidental amount",
      });

      expect(result).toMatchObject({
        success: true,
        fileId: "f-1",
        transactionId: "tx-1",
        dismissedConfidence: 82,
      });

      const file = store.getDoc("files", "f-1");
      expect(file?.transactionSuggestions).toEqual([suggestion("tx-2", 61)]);
      expect(file?.dismissedTransactionIds).toEqual(["tx-1"]);
      expect(file?.dismissedTransactions).toEqual([
        expect.objectContaining({ transactionId: "tx-1", confidence: 82, reason: "coincidental amount" }),
      ]);
    });

    it("should succeed with a null confidence when the pair was not suggested", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId, transactionSuggestions: [] }));

      const result = await handlers.dismissTransactionSuggestion(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
      });

      expect(result).toMatchObject({ success: true, dismissedConfidence: null });
      expect(store.getDoc("files", "f-1")?.dismissedTransactionIds).toEqual(["tx-1"]);
    });

    it("should be idempotent across a sweep re-run", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({ userId, transactionSuggestions: [suggestion("tx-1", 82)] })
      );

      await handlers.dismissTransactionSuggestion(userId, { fileId: "f-1", transactionId: "tx-1" });
      const second = await handlers.dismissTransactionSuggestion(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
      });

      expect(second).toMatchObject({ success: true, dismissedConfidence: null });
      const file = store.getDoc("files", "f-1");
      expect(file?.dismissedTransactionIds).toEqual(["tx-1"]);
      // A second record here would double-count the rejection in the learning export.
      expect(file?.dismissedTransactions).toHaveLength(1);
    });

    it("should refuse a reason longer than 500 characters without writing", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({ userId, transactionSuggestions: [suggestion("tx-1", 82)] })
      );

      await expect(
        handlers.dismissTransactionSuggestion(userId, {
          fileId: "f-1",
          transactionId: "tx-1",
          reason: "x".repeat(501),
        })
      ).rejects.toThrow(/at most 500 characters/);

      expect(store.getDoc("files", "f-1")?.dismissedTransactionIds).toBeUndefined();
    });

    it("should refuse a non-string reason rather than persist it raw", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({ userId, transactionSuggestions: [suggestion("tx-1", 82)] })
      );

      await expect(
        handlers.dismissTransactionSuggestion(userId, {
          fileId: "f-1",
          transactionId: "tx-1",
          reason: { note: "x".repeat(9999) },
        })
      ).rejects.toThrow(/must be a string/);

      expect(store.getDoc("files", "f-1")?.dismissedTransactionIds).toBeUndefined();
    });

    it("should require both ids", async () => {
      await expect(handlers.dismissTransactionSuggestion(userId, {})).rejects.toThrow(
        "fileId is required"
      );
      await expect(
        handlers.dismissTransactionSuggestion(userId, { fileId: "f-1" })
      ).rejects.toThrow("transactionId is required");
      await expect(handlers.undismissTransactionSuggestion(userId, {})).rejects.toThrow(
        "fileId is required"
      );
      await expect(
        handlers.undismissTransactionSuggestion(userId, { fileId: "f-1" })
      ).rejects.toThrow("transactionId is required");
    });

    it("should separate an unknown file from another user's file", async () => {
      await expect(
        handlers.dismissTransactionSuggestion(userId, { fileId: "f-1", transactionId: "tx-1" })
      ).rejects.toThrow("File not found");

      store.setDoc("files", "f-2", createTestFile({ userId: otherUserId }));

      await expect(
        handlers.dismissTransactionSuggestion(userId, { fileId: "f-2", transactionId: "tx-1" })
      ).rejects.toThrow("Access denied");
      await expect(
        handlers.undismissTransactionSuggestion(userId, { fileId: "f-2", transactionId: "tx-1" })
      ).rejects.toThrow("Access denied");

      // The refusal must not have written anything.
      expect(store.getDoc("files", "f-2")?.dismissedTransactionIds).toBeUndefined();
    });

    it("should round-trip dismiss then undismiss, keeping the attempt as history", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({ userId, transactionSuggestions: [suggestion("tx-1", 82)] })
      );

      await handlers.dismissTransactionSuggestion(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
        reason: "coincidence",
      });

      const result = await handlers.undismissTransactionSuggestion(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
      });

      expect(result).toMatchObject({ success: true, wasDismissed: true });

      const file = store.getDoc("files", "f-1");
      // The enforcement list is what undo clears.
      expect(file?.dismissedTransactionIds).toEqual([]);
      // The record survives, stamped, so a later sweep can see what was tried
      // and why rather than re-deriving the same wrong pairing blind.
      expect(file?.dismissedTransactions).toEqual([
        expect.objectContaining({
          transactionId: "tx-1",
          confidence: 82,
          reason: "coincidence",
          undismissedAt: expect.anything(),
        }),
      ]);
      // Undismissing does not fabricate the suggestion back — matching does that.
      expect(file?.transactionSuggestions).toEqual([]);
    });

    it("should log a second rejection after an undo instead of silently keeping one", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({ userId, transactionSuggestions: [suggestion("tx-1", 82)] })
      );

      await handlers.dismissTransactionSuggestion(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
        reason: "first call",
      });
      await handlers.undismissTransactionSuggestion(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
      });
      await handlers.dismissTransactionSuggestion(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
        reason: "second call",
      });

      const file = store.getDoc("files", "f-1");
      // Two decisions logged, one of them reversed...
      expect(file?.dismissedTransactions).toEqual([
        expect.objectContaining({ reason: "first call", undismissedAt: expect.anything() }),
        expect.objectContaining({ reason: "second call" }),
      ]);
      expect(
        (file?.dismissedTransactions as Array<Record<string, unknown>>)[1]
      ).not.toHaveProperty("undismissedAt");
      // ...and exactly one live entry on the list matching enforces against.
      expect(file?.dismissedTransactionIds).toEqual(["tx-1"]);
    });

    it("should report wasDismissed false and write nothing for a pair that was never dismissed", async () => {
      store.setDoc("files", "f-1", createTestFile({ userId }));
      const before = { ...store.getDoc("files", "f-1") };

      const result = await handlers.undismissTransactionSuggestion(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
      });

      expect(result).toMatchObject({ success: true, wasDismissed: false });
      // Not even updatedAt: a sweep clearing a speculative list must not stamp
      // every file it looked at.
      expect(store.getDoc("files", "f-1")).toEqual(before);
    });

    it("should treat a reversed rejection as no rejection at all", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({
          userId,
          dismissedTransactionIds: [],
          dismissedTransactions: [
            {
              transactionId: "tx-1",
              dismissedAt: new Date(),
              confidence: 82,
              reason: null,
              undismissedAt: new Date(),
            },
          ],
        })
      );
      const before = { ...store.getDoc("files", "f-1") };

      const result = await handlers.undismissTransactionSuggestion(userId, {
        fileId: "f-1",
        transactionId: "tx-1",
      });

      expect(result).toMatchObject({ wasDismissed: false });
      expect(store.getDoc("files", "f-1")).toEqual(before);
    });
  });

  describe("retryFileExtractionTool", () => {
    beforeEach(() => {
      extraction.runExtraction.mockReset();
      extraction.runExtraction.mockResolvedValue({ success: true, duration: 12 });
    });

    it("re-extracts a file whose extraction errored", async () => {
      store.setDoc(
        "files",
        "f-1",
        createTestFile({ userId, extractionComplete: true, extractionError: "boom" })
      );

      const result = await handlers.retryFileExtractionTool(userId, { fileId: "f-1" });

      // The tool queues and returns (#603); this build runs the queue inline.
      expect(result).toEqual({ queued: true, fileId: "f-1" });
      expect(extraction.runExtraction).toHaveBeenCalledTimes(1);
      // The reset is written before extraction runs, and matching is re-armed.
      const file = store.getDoc("files", "f-1") as Record<string, unknown>;
      expect(file.extractionError).toBeNull();
      expect(file.partnerMatchComplete).toBe(false);
      expect(file.transactionSuggestions).toEqual([]);
    });

    it("refuses a clean extraction without force, and runs it with force", async () => {
      store.setDoc(
        "files",
        "f-2",
        createTestFile({ userId, extractionComplete: true, extractionError: null })
      );

      await expect(handlers.retryFileExtractionTool(userId, { fileId: "f-2" })).rejects.toThrow(
        /^ALREADY_EXTRACTED:/
      );
      expect(extraction.runExtraction).not.toHaveBeenCalled();

      await handlers.retryFileExtractionTool(userId, { fileId: "f-2", force: true });
      expect(extraction.runExtraction).toHaveBeenCalledTimes(1);
    });

    // #184: the whole point — a sweep must not re-roll the model over a value a
    // person decided, and force cannot be the flag that protects it because
    // every sweep (and the UI button) passes force already.
    it("refuses a hand-corrected file, naming the fields, even when forced", async () => {
      store.setDoc(
        "files",
        "f-corrected",
        createTestFile({
          userId,
          extractionComplete: true,
          extractedVatPercent: 0,
          extractionCorrectedFields: { vatPercent: new Date(), amount: new Date() },
        })
      );

      await expect(
        handlers.retryFileExtractionTool(userId, { fileId: "f-corrected" })
      ).rejects.toThrow(/^HAND_CORRECTED: .*\(amount, vatPercent\)/);
      await expect(
        handlers.retryFileExtractionTool(userId, { fileId: "f-corrected", force: true })
      ).rejects.toThrow(/^HAND_CORRECTED:/);

      expect(extraction.runExtraction).not.toHaveBeenCalled();
      // A refused retry leaves the record alone — the corrected rate is intact.
      expect((store.getDoc("files", "f-corrected") as Record<string, unknown>).extractedVatPercent).toBe(0);
    });

    it("re-extracts a corrected file when the caller says so per file", async () => {
      store.setDoc(
        "files",
        "f-corrected",
        createTestFile({
          userId,
          extractionComplete: true,
          extractionCorrectedFields: { vatPercent: new Date() },
        })
      );

      // Both flags: force answers "it already extracted cleanly",
      // overwriteCorrections answers "and a person corrected it".
      await handlers.retryFileExtractionTool(userId, {
        fileId: "f-corrected",
        force: true,
        overwriteCorrections: true,
      });

      expect(extraction.runExtraction).toHaveBeenCalledTimes(1);
      // The marker is not cleared: a person did rule on this document, and the
      // file stays on the next sweep's exclusion list rather than falling off
      // it because it was overridden once.
      const marker = (store.getDoc("files", "f-corrected") as Record<string, unknown>)
        .extractionCorrectedFields as Record<string, unknown>;
      expect(Object.keys(marker)).toEqual(["vatPercent"]);
    });

    it("keeps a manual partner assignment across the reset", async () => {
      store.setDoc(
        "files",
        "f-3",
        createTestFile({
          userId,
          extractionComplete: true,
          extractionError: "boom",
          partnerId: "p-manual",
          partnerMatchedBy: "manual",
        })
      );

      await handlers.retryFileExtractionTool(userId, { fileId: "f-3" });

      const file = store.getDoc("files", "f-3") as Record<string, unknown>;
      expect(file.partnerId).toBe("p-manual");
      expect(file.partnerMatchedBy).toBe("manual");
    });

    it("refuses another user's file without touching it", async () => {
      store.setDoc(
        "files",
        "f-4",
        createTestFile({ userId: otherUserId, extractionComplete: true, extractionError: "boom" })
      );

      await expect(handlers.retryFileExtractionTool(userId, { fileId: "f-4" })).rejects.toThrow(
        /^ACCESS_DENIED:/
      );
      expect(extraction.runExtraction).not.toHaveBeenCalled();
      expect((store.getDoc("files", "f-4") as Record<string, unknown>).extractionError).toBe("boom");
    });

    it("distinguishes a missing file from one that is not the caller's", async () => {
      await expect(handlers.retryFileExtractionTool(userId, { fileId: "nope" })).rejects.toThrow(
        /^NOT_FOUND:/
      );
      await expect(handlers.retryFileExtractionTool(userId, {})).rejects.toThrow(
        "fileId is required"
      );
    });

    it("stamps a failed extraction on the document, where the agent reads it", async () => {
      store.setDoc(
        "files",
        "f-5",
        createTestFile({ userId, extractionComplete: true, extractionError: "boom" })
      );
      extraction.runExtraction.mockRejectedValue(new Error("No such object: missing/nope.pdf"));

      // Queued, not refused: how the Extraction went is on the File (#603).
      await expect(handlers.retryFileExtractionTool(userId, { fileId: "f-5" })).resolves.toEqual({
        queued: true,
        fileId: "f-5",
      });

      const file = store.getDoc("files", "f-5") as Record<string, unknown>;
      expect(file.extractionComplete).toBe(true);
      expect(file.extractionError).toBe("No such object: missing/nope.pdf");
    });

    it("is reachable through the dispatcher, behind the aiExtraction gate", async () => {
      store.setDoc(
        "files",
        "f-6",
        createTestFile({ userId, extractionComplete: true, extractionError: "boom" })
      );

      // Extraction spends an AI call, so the tool is gated like the other AI
      // tools. On the free plan the dispatcher refuses it before the handler.
      await expect(
        handlers.handleTool(userId, "retry_file_extraction", { fileId: "f-6" })
      ).rejects.toThrow(/requires the "aiExtraction" feature/);
      expect(extraction.runExtraction).not.toHaveBeenCalled();

      store.setDoc("subscriptions", userId, { plan: "smart" });
      await handlers.handleTool(userId, "retry_file_extraction", { fileId: "f-6" });
      expect(extraction.runExtraction).toHaveBeenCalledTimes(1);
    });
  });
});
