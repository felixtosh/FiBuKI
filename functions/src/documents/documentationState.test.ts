/**
 * Transaction documentation state (#104).
 *
 * The derivation the onTransactionUpdate trigger runs, and the guard that
 * decides when it runs — both pure, so the trigger's behaviour is tested here
 * rather than mirrored in a copy that can drift.
 */

import { describe, it, expect } from "vitest";
import {
  deriveDocumentationState,
  documentationStateChanged,
  shouldRecomputeDocumentationState,
} from "./documentationState";

describe("deriveDocumentationState", () => {
  it("reads a transaction holding one invoice as documented with an invoice", () => {
    expect(
      deriveDocumentationState({ fileTypes: ["invoice"], hasNoReceiptCategory: false })
    ).toBe("invoice");
  });

  it("lets an invoice win over a co-attached receipt", () => {
    expect(
      deriveDocumentationState({ fileTypes: ["receipt", "invoice"], hasNoReceiptCategory: false })
    ).toBe("invoice");
    expect(
      deriveDocumentationState({ fileTypes: ["invoice", "receipt"], hasNoReceiptCategory: false })
    ).toBe("invoice");
  });

  it("reads a transaction holding only a receipt as receipt-only", () => {
    expect(
      deriveDocumentationState({ fileTypes: ["receipt"], hasNoReceiptCategory: false })
    ).toBe("receipt-only");
  });

  it("reads a receipt alongside an unclassified file as receipt-only", () => {
    expect(
      deriveDocumentationState({ fileTypes: ["unknown", "receipt"], hasNoReceiptCategory: false })
    ).toBe("receipt-only");
  });

  it("reads files whose types are all unknown as unknown", () => {
    expect(
      deriveDocumentationState({ fileTypes: ["unknown", "unknown"], hasNoReceiptCategory: false })
    ).toBe("unknown");
  });

  it("treats a file record that predates classification as unknown, not as absent", () => {
    expect(
      deriveDocumentationState({ fileTypes: [null, undefined], hasNoReceiptCategory: false })
    ).toBe("unknown");
  });

  it("reads non-financial attachments as unknown, since they say nothing about a missing invoice", () => {
    expect(
      deriveDocumentationState({ fileTypes: ["other"], hasNoReceiptCategory: false })
    ).toBe("unknown");
  });

  it("reads a no-receipt category with no files as its own state", () => {
    expect(deriveDocumentationState({ fileTypes: [], hasNoReceiptCategory: true })).toBe(
      "no-receipt-category"
    );
  });

  it("keeps a documented transaction distinguishable from a no-receipt-category one", () => {
    expect(
      deriveDocumentationState({ fileTypes: ["invoice"], hasNoReceiptCategory: true })
    ).toBe("invoice");
    expect(
      deriveDocumentationState({ fileTypes: ["receipt"], hasNoReceiptCategory: true })
    ).toBe("receipt-only");
  });

  it("reads a transaction with neither files nor a category as undocumented", () => {
    expect(deriveDocumentationState({ fileTypes: [], hasNoReceiptCategory: false })).toBe(
      "undocumented"
    );
  });
});

describe("shouldRecomputeDocumentationState", () => {
  it("fires when the attached files change", () => {
    expect(
      shouldRecomputeDocumentationState(
        { fileIds: [], noReceiptCategoryId: null, documentationState: "undocumented" },
        { fileIds: ["file-1"], noReceiptCategoryId: null, documentationState: "undocumented" }
      )
    ).toBe(true);
  });

  it("fires when the no-receipt category changes", () => {
    expect(
      shouldRecomputeDocumentationState(
        { fileIds: [], noReceiptCategoryId: null, documentationState: "undocumented" },
        { fileIds: [], noReceiptCategoryId: "cat-1", documentationState: "undocumented" }
      )
    ).toBe(true);
  });

  it("fires once when the state has never been derived, so existing rows fill in", () => {
    expect(
      shouldRecomputeDocumentationState(
        { fileIds: ["file-1"], noReceiptCategoryId: null },
        { fileIds: ["file-1"], noReceiptCategoryId: null }
      )
    ).toBe(true);
  });

  it("does not fire on an unrelated edit once the state is present", () => {
    expect(
      shouldRecomputeDocumentationState(
        { fileIds: ["file-1"], noReceiptCategoryId: null, documentationState: "invoice" },
        { fileIds: ["file-1"], noReceiptCategoryId: null, documentationState: "invoice" }
      )
    ).toBe(false);
  });

  // #215: writers that flip the flag without touching files or category (the
  // callables, bulk updates, any direct writer) must re-derive, or a bare
  // line marked complete stays `undocumented` forever.
  it("fires when isComplete flips with files and category unchanged", () => {
    expect(
      shouldRecomputeDocumentationState(
        { fileIds: [], noReceiptCategoryId: null, isComplete: false, documentationState: "undocumented" },
        { fileIds: [], noReceiptCategoryId: null, isComplete: true, documentationState: "undocumented" }
      )
    ).toBe(true);
  });

  it("does not fire again after the isComplete-triggered write settles", () => {
    const after = {
      fileIds: [],
      noReceiptCategoryId: null,
      isComplete: true,
      documentationState: "undocumented" as const,
    };
    expect(shouldRecomputeDocumentationState(after, after)).toBe(false);
  });

  it("does not fire on the write it just made, so the trigger cannot loop", () => {
    const before = { fileIds: [], noReceiptCategoryId: null, documentationState: "undocumented" };
    const after = { fileIds: ["file-1"], noReceiptCategoryId: null, documentationState: "invoice" };

    // First pass: fileIds changed, so the recompute runs and writes.
    expect(shouldRecomputeDocumentationState(before, after)).toBe(true);
    // The write re-fires the trigger with before === after; nothing changed now.
    expect(shouldRecomputeDocumentationState(after, after)).toBe(false);
  });
});

describe("documentationStateChanged", () => {
  it("reports a change when the stored state differs from the derived one", () => {
    expect(documentationStateChanged("receipt-only", "invoice")).toBe(true);
  });

  it("reports a change when nothing was ever stored", () => {
    expect(documentationStateChanged(undefined, "undocumented")).toBe(true);
  });

  it("reports no change when the stored state already matches", () => {
    expect(documentationStateChanged("invoice", "invoice")).toBe(false);
  });
});
