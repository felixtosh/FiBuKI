import test from "node:test";
import assert from "node:assert/strict";
import { needsPartner } from "../lib/reports/needs-partner.js";

const tx = (over = {}) => ({ amount: -25000, partnerId: null, noReceiptCategoryId: null, ...over });

test("a line over 100 EUR with no Partner needs one", () => {
  assert.equal(needsPartner(tx()), true);
  assert.equal(needsPartner(tx({ amount: 25000 })), true);
});

test("a line with a Partner does not", () => {
  assert.equal(needsPartner(tx({ partnerId: "p1" })), false);
});

test("a line of 100 EUR or less does not", () => {
  assert.equal(needsPartner(tx({ amount: -10000 })), false);
  assert.equal(needsPartner(tx({ amount: 9999 })), false);
});

test("a line a Category explains does not: an own transfer or a tax payment has no counterparty to name", () => {
  assert.equal(needsPartner(tx({ noReceiptCategoryId: "internal-transfers" })), false);
  assert.equal(needsPartner(tx({ amount: -336310, noReceiptCategoryId: "taxes" })), false);
});
