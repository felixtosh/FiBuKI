import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeVatId,
  findVatIdConflicts,
  isEmptyValue,
  fieldGains,
  newEntryCount,
} from "../lib/partners/merge-preview.js";

test("normalizeVatId: uppercases and strips whitespace, same as the backend", () => {
  assert.equal(normalizeVatId(" atu 1234 5678 "), "ATU12345678");
  assert.equal(normalizeVatId(undefined), "");
  assert.equal(normalizeVatId(null), "");
  assert.equal(normalizeVatId(42), "");
});

test("findVatIdConflicts: no conflict when only one partner has a VAT ID", () => {
  const conflicts = findVatIdConflicts([
    { id: "s", name: "Survivor", vatId: "ATU11111111" },
    { id: "l", name: "Loser", vatId: undefined },
  ]);
  assert.deepEqual(conflicts, []);
});

test("findVatIdConflicts: no conflict when VAT IDs match after normalization", () => {
  const conflicts = findVatIdConflicts([
    { id: "s", name: "Survivor", vatId: "ATU 1111 1111" },
    { id: "l", name: "Loser", vatId: "atu11111111" },
  ]);
  assert.deepEqual(conflicts, []);
});

test("findVatIdConflicts: differing non-empty VAT IDs conflict, survivor vs loser", () => {
  const conflicts = findVatIdConflicts([
    { id: "s", name: "Survivor", vatId: "ATU11111111" },
    { id: "l", name: "Loser", vatId: "ATU22222222" },
  ]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].a.vatId, "ATU11111111");
  assert.equal(conflicts[0].b.vatId, "ATU22222222");
});

test("findVatIdConflicts: two losers disagreeing is a conflict too, not just survivor-vs-loser", () => {
  const conflicts = findVatIdConflicts([
    { id: "s", name: "Survivor", vatId: undefined },
    { id: "l1", name: "Loser 1", vatId: "ATU11111111" },
    { id: "l2", name: "Loser 2", vatId: "ATU22222222" },
  ]);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].a.id, "l1");
  assert.equal(conflicts[0].b.id, "l2");
});

test("isEmptyValue: empty string, empty array, empty object and nullish are empty", () => {
  for (const value of ["", "   ", [], {}, null, undefined]) {
    assert.equal(isEmptyValue(value), true, JSON.stringify(value));
  }
});

test("isEmptyValue: a real value is not empty", () => {
  for (const value of ["ATU11111111", ["x"], { street: "x" }, 0, false]) {
    assert.equal(isEmptyValue(value), false, JSON.stringify(value));
  }
});

test("fieldGains: survivor gains a field it lacks from the first loser that has it", () => {
  const survivor = { website: "", vatId: "ATU11111111" };
  const losers = [
    { name: "Loser 1", website: "" },
    { name: "Loser 2", website: "loser2.example" },
  ];
  const gains = fieldGains(survivor, losers);
  assert.deepEqual(gains, [{ field: "website", label: "website", fromName: "Loser 2" }]);
});

test("fieldGains: nothing gained when the survivor already holds every field", () => {
  const survivor = { vatId: "ATU11111111", website: "survivor.example", address: { city: "Vienna" } };
  const losers = [{ name: "Loser", vatId: "ATU22222222", website: "loser.example" }];
  assert.deepEqual(fieldGains(survivor, losers), []);
});

test("newEntryCount: counts only entries the survivor does not already have", () => {
  const survivorIbans = ["AT001", "AT002"];
  const loserIbans = [["AT002", "AT003"], ["AT004"]];
  assert.equal(
    newEntryCount(survivorIbans, loserIbans, (v) => String(v).toUpperCase()),
    2,
  );
});

test("newEntryCount: the same new entry from two losers counts once", () => {
  assert.equal(
    newEntryCount(["AT001"], [["AT002"], ["AT002"]], (v) => String(v).toUpperCase()),
    1,
  );
});

test("newEntryCount: a partner missing the list entirely has none of it", () => {
  // Older Partner documents predate `aliases`/`ibans`, so both the survivor's
  // list and a loser's can be absent rather than empty.
  assert.equal(newEntryCount(undefined, [["a"], undefined, null], (v) => String(v)), 1);
  assert.equal(newEntryCount(null, [], (v) => String(v)), 0);
});

test("newEntryCount: zero when the survivor already has everything", () => {
  assert.equal(
    newEntryCount(["a", "b"], [["a"], ["b"]], (v) => String(v)),
    0,
  );
});
