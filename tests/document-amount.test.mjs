import test from "node:test";
import assert from "node:assert/strict";
import { fileDocumentAmount } from "../lib/files/document-amount.js";

const ticket = (vatAmount) => ({
  description: "EINTRITTSKARTE, ERWACHSENE",
  vatPercent: 20,
  vatAmount,
  amount: 950,
});

test("fileDocumentAmount: the stored total wins over rows whose VAT reads as net (#504)", () => {
  // The live case: each row carries the document's whole VAT. The old
  // net/gross guess read the rows as net and showed 1900 + 634 = 2534.
  const file = { extractedAmount: 1900, extractedLineItems: [ticket(317), ticket(317)] };
  assert.equal(fileDocumentAmount(file), 1900);
});

test("fileDocumentAmount: the stored total wins over rows that do not sum to it", () => {
  const file = { extractedAmount: 1900, extractedLineItems: [ticket(158)] };
  assert.equal(fileDocumentAmount(file), 1900);
});

test("fileDocumentAmount: with no stored total, the rows sum as billed", () => {
  const file = { extractedAmount: null, extractedLineItems: [ticket(317), ticket(317)] };
  assert.equal(fileDocumentAmount(file), 1900);
});

test("fileDocumentAmount: flagged rows never stand in for a missing total (#203)", () => {
  const file = {
    extractedAmount: null,
    extractedLineItems: [ticket(158), ticket(159)],
    lineItemsUnreconciled: true,
  };
  assert.equal(fileDocumentAmount(file), null);
});

test("fileDocumentAmount: nothing extracted is null", () => {
  assert.equal(fileDocumentAmount({}), null);
  assert.equal(fileDocumentAmount({ extractedLineItems: [] }), null);
});

test("fileDocumentAmount: a stored zero is a real total", () => {
  assert.equal(fileDocumentAmount({ extractedAmount: 0, extractedLineItems: [ticket(0)] }), 0);
});
