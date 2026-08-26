import test from "node:test";
import assert from "node:assert/strict";
import {
  cadenceOf,
  chargeWindowState,
  coverageState,
  declarationFor,
  isRecurringPartner,
} from "../lib/partners/billing-cycle-presentation.js";

const DAY = 24 * 60 * 60 * 1000;

function window(fromIso, toIso) {
  return { from: new Date(fromIso), to: new Date(toIso) };
}

test("cadenceOf: the four named cadences read by their name", () => {
  assert.deepEqual(
    [7, 30, 90, 365].map(cadenceOf),
    ["weekly", "monthly", "quarterly", "yearly"],
  );
});

test("cadenceOf: a month learned as 28 or 31 days still reads as monthly", () => {
  for (const days of [27, 28, 30, 31, 33]) {
    assert.equal(cadenceOf(days), "monthly", `${days} days`);
  }
});

test("cadenceOf: a fortnightly partner keeps its own interval", () => {
  assert.equal(cadenceOf(14), "custom");
  assert.equal(cadenceOf(60), "custom");
});

test("cadenceOf: nothing to render is null, never a cadence of zero days", () => {
  for (const value of [undefined, null, 0, -30, NaN, "30"]) {
    assert.equal(cadenceOf(value), null);
  }
});

test("isRecurringPartner: an effective recurrence is what makes a partner recurring", () => {
  assert.equal(
    isRecurringPartner({ billingCycle: { effective: [{ source: "learned", frequencyDays: 30 }] } }),
    true,
  );
});

test("isRecurringPartner: a learned half that resolved to nothing is not recurring", () => {
  assert.equal(isRecurringPartner({ billingCycle: { learned: [], effective: [] } }), false);
  assert.equal(isRecurringPartner({ billingCycle: {} }), false);
  assert.equal(isRecurringPartner({}), false);
  assert.equal(isRecurringPartner(null), false);
});

test("chargeWindowState: before, inside and past the window", () => {
  const w = window("2026-08-20T00:00:00Z", "2026-08-28T00:00:00Z");
  assert.equal(chargeWindowState(w, new Date("2026-08-19T00:00:00Z")), "upcoming");
  assert.equal(chargeWindowState(w, new Date("2026-08-24T00:00:00Z")), "due");
  assert.equal(chargeWindowState(w, new Date("2026-08-29T00:00:00Z")), "overdue");
});

test("chargeWindowState: late but still inside the learned variance is due, not overdue", () => {
  const expectedAt = new Date("2026-08-20T00:00:00Z");
  const w = {
    from: new Date(expectedAt.getTime() - 4 * DAY),
    to: new Date(expectedAt.getTime() + 4 * DAY),
  };
  assert.equal(chargeWindowState(w, new Date("2026-08-23T00:00:00Z")), "due");
});

test("chargeWindowState: no window, or an unusable one, is unknown", () => {
  const w = window("2026-08-20T00:00:00Z", "2026-08-28T00:00:00Z");
  assert.equal(chargeWindowState(null, new Date("2026-08-24T00:00:00Z")), "unknown");
  assert.equal(chargeWindowState({}, new Date("2026-08-24T00:00:00Z")), "unknown");
  assert.equal(chargeWindowState(w, new Date("nope")), "unknown");
  assert.equal(
    chargeWindowState(window("nope", "2026-08-28T00:00:00Z"), new Date("2026-08-24T00:00:00Z")),
    "unknown",
  );
});

test("coverageState: a recurrence with no charge in the window is empty, not complete", () => {
  assert.equal(coverageState({ charges: 0, withFile: 0, withCategory: 0, missing: 0 }), "empty");
  assert.equal(coverageState(null), "empty");
});

test("coverageState: a charge covered by a category counts as covered", () => {
  assert.equal(
    coverageState({ charges: 6, withFile: 2, withCategory: 4, missing: 0 }),
    "complete",
  );
});

test("coverageState: partial and none are told apart", () => {
  assert.equal(coverageState({ charges: 6, withFile: 5, withCategory: 0, missing: 1 }), "partial");
  assert.equal(coverageState({ charges: 6, withFile: 0, withCategory: 0, missing: 6 }), "none");
});

test("declarationFor: a learned recurrence has no declaration behind it", () => {
  const declared = [{ frequencyDays: 30, amountBand: 90_00 }];
  assert.equal(declarationFor(declared, { source: "learned", frequencyDays: 30 }), null);
  assert.equal(declarationFor([], { source: "declared", frequencyDays: 30 }), null);
});

test("declarationFor: a lone declaration needs no band to be found", () => {
  const declared = [{ frequencyDays: 30, expectedAmountMin: 80_00, expectedAmountMax: 100_00 }];
  assert.equal(
    declarationFor(declared, { source: "declared", frequencyDays: 30 }),
    declared[0],
  );
});

test("declarationFor: two bands are matched by the band, not by position", () => {
  const declared = [
    { frequencyDays: 7, amountBand: 38_25 },
    { frequencyDays: 30, amountBand: 180_00 },
  ];
  assert.equal(
    declarationFor(declared, { source: "declared", frequencyDays: 30, amountBand: 180_00 }),
    declared[1],
  );
  assert.equal(
    declarationFor(declared, { source: "declared", frequencyDays: 7, amountBand: 38_25 }),
    declared[0],
  );
  // A band nobody declared must not fall back onto a neighbour's edges.
  assert.equal(
    declarationFor(declared, { source: "declared", frequencyDays: 90, amountBand: 12_00 }),
    null,
  );
});
