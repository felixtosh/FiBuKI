import test from "node:test";
import assert from "node:assert/strict";
import { describeLineItemsUnreconciled } from "../lib/documents/line-item-presentation.js";

test("describeLineItemsUnreconciled: a reconciled file (or one never itemised) shows nothing", () => {
  for (const file of [
    { lineItemsUnreconciled: false },
    { lineItemsUnreconciled: null },
    {},
    null,
    undefined,
  ]) {
    assert.equal(describeLineItemsUnreconciled(file), null);
  }
});

test("describeLineItemsUnreconciled: localised damage names the failing rate", () => {
  const presentation = describeLineItemsUnreconciled({
    lineItemsUnreconciled: true,
    lineItemsUnreconciledRates: [20],
  });

  assert.equal(presentation.tone, "warning");
  assert.deepEqual(presentation.rates, [20]);
  assert.ok(presentation.text.includes("20%"));
});

test("describeLineItemsUnreconciled: multiple failing rates are all named", () => {
  const presentation = describeLineItemsUnreconciled({
    lineItemsUnreconciled: true,
    lineItemsUnreconciledRates: [20, 10],
  });

  assert.ok(presentation.text.includes("20%"));
  assert.ok(presentation.text.includes("10%"));
});

test("describeLineItemsUnreconciled: damage that could not be localised reads as the whole document, not a rate", () => {
  for (const rates of [[], null, undefined]) {
    const presentation = describeLineItemsUnreconciled({
      lineItemsUnreconciled: true,
      lineItemsUnreconciledRates: rates,
    });

    assert.deepEqual(presentation.rates, []);
    assert.ok(!presentation.text.includes("%"));
    assert.ok(presentation.text.toLowerCase().includes("not be localised"));
  }
});
