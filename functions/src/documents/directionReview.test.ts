/**
 * The invoice-direction review rule (#233).
 *
 * The invariant this encodes was found by auditing real links: once a file is
 * linked to a transaction, direction is no longer a guess. An incoming
 * document belongs on money going out; an outgoing one on money coming in.
 * Every disagreement in that audit turned out to be a real defect — sales
 * invoices stapled to unrelated outgoing payments, one of them to a tax
 * payment.
 */

import { describe, it, expect } from "vitest";
import { reviewDirection, toDirectionFacts, directionReviewFields } from "./directionReview";

describe("reviewDirection — the cross-check against linked transactions", () => {
  it("flags an incoming document sitting on money that went out of the account", () => {
    // The shape found on real data: a sales invoice stapled to an unrelated
    // outgoing payment, which is money leaving the account.
    const result = reviewDirection({
      invoiceDirection: "outgoing",
      transactions: [{ id: "tx-1", amount: -400000 }],
    });

    expect(result.needsReview).toBe(true);
    expect(result.reason).toBe("conflict");
    expect(result.conflictingTransactionIds).toEqual(["tx-1"]);
    expect(result.suggestedDirection).toBe("incoming");
  });

  it("flags a purchase document sitting on money that came in", () => {
    const result = reviewDirection({
      invoiceDirection: "incoming",
      transactions: [{ id: "tx-2", amount: 5896 }],
    });

    expect(result.needsReview).toBe(true);
    expect(result.reason).toBe("conflict");
    expect(result.suggestedDirection).toBe("outgoing");
  });

  it("says nothing when the document and the money agree", () => {
    expect(
      reviewDirection({
        invoiceDirection: "incoming",
        transactions: [{ id: "tx-3", amount: -12000 }],
      })
    ).toEqual({
      needsReview: false,
      reason: null,
      conflictingTransactionIds: [],
      suggestedDirection: null,
    });

    expect(
      reviewDirection({
        invoiceDirection: "outgoing",
        transactions: [{ id: "tx-4", amount: 200000 }],
      }).needsReview
    ).toBe(false);
  });

  it("names only the transactions that actually disagree", () => {
    const result = reviewDirection({
      invoiceDirection: "incoming",
      transactions: [
        { id: "tx-ok", amount: -5000 },
        { id: "tx-bad", amount: 5000 },
      ],
    });

    expect(result.conflictingTransactionIds).toEqual(["tx-bad"]);
  });

  it("suggests nothing when the linked transactions disagree with each other", () => {
    const result = reviewDirection({
      invoiceDirection: "unknown",
      transactions: [
        { id: "a", amount: -5000 },
        { id: "b", amount: 5000 },
      ],
    });

    expect(result.needsReview).toBe(true);
    expect(result.suggestedDirection).toBeNull();
  });

  it("ignores a zero-amount transaction, which points nowhere", () => {
    const result = reviewDirection({
      invoiceDirection: "incoming",
      transactions: [{ id: "tx-zero", amount: 0 }],
    });

    expect(result.needsReview).toBe(false);
  });
});

describe("reviewDirection — the undirected population", () => {
  it("flags a file whose direction was never established", () => {
    // A large minority of a real file set sits in this state, rendering as
    // positive green figures indistinguishable from income, with nothing in
    // the product saying so.
    const result = reviewDirection({ invoiceDirection: "unknown", transactions: [] });

    expect(result.needsReview).toBe(true);
    expect(result.reason).toBe("unknown-direction");
    expect(result.suggestedDirection).toBeNull();
  });

  it("treats an absent field the same as an explicit unknown", () => {
    expect(reviewDirection({ transactions: [] }).reason).toBe("unknown-direction");
  });

  it("suggests the direction the linked transaction implies", () => {
    const result = reviewDirection({
      invoiceDirection: "unknown",
      transactions: [{ id: "tx", amount: -12000 }],
    });

    expect(result.reason).toBe("unknown-direction");
    expect(result.suggestedDirection).toBe("incoming");
  });
});

describe("reviewDirection — what is out of scope", () => {
  it("says nothing about a document that is not a financial document at all", () => {
    const result = reviewDirection({
      invoiceDirection: "unknown",
      transactions: [],
      isNotInvoice: true,
    });

    expect(result.needsReview).toBe(false);
  });

  it("waits for extraction rather than flagging a file that has not run yet", () => {
    const result = reviewDirection({
      invoiceDirection: "unknown",
      transactions: [],
      extractionComplete: false,
    });

    expect(result.needsReview).toBe(false);
  });
});

describe("toDirectionFacts", () => {
  it("reads the stored record, defaulting the fields it predates", () => {
    const facts = toDirectionFacts(
      { invoiceDirection: "incoming", isNotInvoice: false, extractionComplete: true },
      [{ id: "tx", amount: -100 }]
    );

    expect(facts).toEqual({
      invoiceDirection: "incoming",
      transactions: [{ id: "tx", amount: -100 }],
      isNotInvoice: false,
      extractionComplete: true,
    });
  });

  it("does not read a nonsense direction as a direction", () => {
    expect(toDirectionFacts({ invoiceDirection: "sideways" }, []).invoiceDirection).toBe("unknown");
  });

  it("treats a record with no extractionComplete field as not yet extracted", () => {
    expect(toDirectionFacts({}, []).extractionComplete).toBe(false);
  });
});

describe("directionReviewFields", () => {
  it("carries no undefined, which Firestore refuses to store", () => {
    const fields = directionReviewFields(
      reviewDirection({ invoiceDirection: "unknown", transactions: [] })
    );

    expect(Object.keys(fields).sort()).toEqual([
      "directionConflictTransactionIds",
      "directionReviewReason",
      "directionSuggested",
      "needsDirectionReview",
    ]);
    for (const value of Object.values(fields)) expect(value).not.toBeUndefined();
  });

  it("writes the cleared shape when there is nothing to review", () => {
    const fields = directionReviewFields(
      reviewDirection({ invoiceDirection: "incoming", transactions: [{ id: "t", amount: -1 }] })
    );

    expect(fields).toEqual({
      needsDirectionReview: false,
      directionReviewReason: null,
      directionSuggested: null,
      directionConflictTransactionIds: [],
    });
  });
});
