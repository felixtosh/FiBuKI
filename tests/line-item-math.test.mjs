import test from "node:test";
import assert from "node:assert/strict";
import { updateLineItemRow, lineItemRowProblem, blocksSave } from "../lib/files/line-item-math.js";

const row = (vatPercent, vatAmount, amount) => ({ description: "Tacos", vatPercent, vatAmount, amount });

test("typing a rate recomputes the VAT inside the gross", () => {
  // Stefan's Tacos: 10 % of 26,80 gross is 2,44, not the 2,68 typed.
  assert.deepEqual(updateLineItemRow(row("", "", "26.80"), "vatPercent", "10"), row("10", "2.44", "26.80"));
  assert.equal(updateLineItemRow(row("", "", "26,80"), "vatPercent", "20").vatAmount, "4.47");
});

test("typing a VAT amount recomputes the rate, snapping to a known one", () => {
  assert.equal(updateLineItemRow(row("", "", "26.80"), "vatAmount", "2.44").vatPercent, "10");
  assert.equal(updateLineItemRow(row("", "", "67.50"), "vatAmount", "11,25").vatPercent, "20");
  // No known rate reproduces it: the exact figure, one decimal.
  assert.equal(updateLineItemRow(row("", "", "10.00"), "vatAmount", "0.77").vatPercent, "8.3");
});

test("typing a gross keeps the rate and moves the VAT", () => {
  assert.equal(updateLineItemRow(row("20", "5.17", "31.00"), "amount", "15.50").vatAmount, "2.58");
  // No rate yet: the rate follows the VAT instead.
  assert.equal(updateLineItemRow(row("", "2.44", ""), "amount", "26.80").vatPercent, "10");
});

test("clearing one coupled box clears the other", () => {
  assert.deepEqual(updateLineItemRow(row("10", "2.44", "26.80"), "vatPercent", ""), row("", "", "26.80"));
  assert.deepEqual(updateLineItemRow(row("10", "2.44", "26.80"), "vatAmount", ""), row("", "", "26.80"));
});

test("a box that does not parse leaves the others alone", () => {
  assert.deepEqual(updateLineItemRow(row("10", "2.44", "26.80"), "vatPercent", "1x"), row("1x", "2.44", "26.80"));
  assert.deepEqual(updateLineItemRow(row("10", "2.44", "26.80"), "amount", "abc"), row("10", "2.44", "abc"));
});

test("the description never moves a number", () => {
  assert.deepEqual(updateLineItemRow(row("10", "2.44", "26.80"), "description", "Burrito"), {
    ...row("10", "2.44", "26.80"),
    description: "Burrito",
  });
});

test("a VAT no rate can produce is a problem that blocks saving", () => {
  assert.equal(lineItemRowProblem(row("", "39.30", "39.30")), "vatNotInsideAmount");
  assert.equal(lineItemRowProblem(row("", "-1.00", "10.00")), "vatNotInsideAmount");
  assert.equal(blocksSave("vatNotInsideAmount"), true);
  assert.equal(lineItemRowProblem(row("120", "", "10.00")), "rateOutOfRange");
  assert.equal(blocksSave("rateOutOfRange"), true);
});

test("a rate above every EU rate is a warning, not a block", () => {
  // Quesadilla: 39,3 %
  assert.equal(lineItemRowProblem(row("39.3", "11.09", "39.30")), "rateUnusual");
  assert.equal(blocksSave("rateUnusual"), false);
  assert.equal(lineItemRowProblem(row("20", "4.47", "26.80")), null);
  assert.equal(lineItemRowProblem(row("", "", "")), null);
});

test("a credit row keeps a negative VAT inside a negative gross", () => {
  assert.equal(updateLineItemRow(row("", "", "-12.00"), "vatPercent", "20").vatAmount, "-2.00");
  assert.equal(lineItemRowProblem(row("20", "-2.00", "-12.00")), null);
});
