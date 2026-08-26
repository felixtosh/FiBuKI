import test from "node:test";
import assert from "node:assert/strict";
import {
  toggleFileCheckbox,
  toggleSelectAll,
  getSelectAllCheckedState,
} from "../lib/selection/bulk-file-selection.js";

test("toggleFileCheckbox: checking a non-primary row adds it to the additional set", () => {
  const result = toggleFileCheckbox({
    fileId: "b",
    checked: true,
    primarySelectedId: "a",
    additionalSelectedIds: new Set(),
  });
  assert.deepEqual([...result.additionalSelectedIds], ["b"]);
  assert.equal(result.closePrimary, false);
});

test("toggleFileCheckbox: checking the primary row is a no-op (already selected)", () => {
  const result = toggleFileCheckbox({
    fileId: "a",
    checked: true,
    primarySelectedId: "a",
    additionalSelectedIds: new Set(),
  });
  assert.deepEqual([...result.additionalSelectedIds], []);
  assert.equal(result.closePrimary, false);
});

test("toggleFileCheckbox: unchecking a non-primary row removes it", () => {
  const result = toggleFileCheckbox({
    fileId: "b",
    checked: false,
    primarySelectedId: "a",
    additionalSelectedIds: new Set(["b", "c"]),
  });
  assert.deepEqual([...result.additionalSelectedIds], ["c"]);
  assert.equal(result.closePrimary, false);
});

test("toggleFileCheckbox: unchecking the primary row's own checkbox closes it", () => {
  const result = toggleFileCheckbox({
    fileId: "a",
    checked: false,
    primarySelectedId: "a",
    additionalSelectedIds: new Set(["b"]),
  });
  assert.deepEqual([...result.additionalSelectedIds], ["b"]);
  assert.equal(result.closePrimary, true);
});

test("toggleFileCheckbox: works with no primary selection at all", () => {
  const result = toggleFileCheckbox({
    fileId: "a",
    checked: true,
    primarySelectedId: null,
    additionalSelectedIds: new Set(),
  });
  assert.deepEqual([...result.additionalSelectedIds], ["a"]);
  assert.equal(result.closePrimary, false);
});

test("toggleSelectAll: selects every displayed row not already primary", () => {
  const result = toggleSelectAll({
    displayedFileIds: ["a", "b", "c"],
    primarySelectedId: "a",
    additionalSelectedIds: new Set(),
  });
  assert.deepEqual([...result.additionalSelectedIds].sort(), ["b", "c"]);
  assert.equal(result.closePrimary, false);
});

test("toggleSelectAll: deselects all when everything displayed is already selected", () => {
  const result = toggleSelectAll({
    displayedFileIds: ["a", "b", "c"],
    primarySelectedId: "a",
    additionalSelectedIds: new Set(["b", "c"]),
  });
  assert.deepEqual([...result.additionalSelectedIds], []);
  assert.equal(result.closePrimary, true);
});

test("toggleSelectAll: deselect-all does not close primary when primary isn't displayed", () => {
  const result = toggleSelectAll({
    displayedFileIds: ["b", "c"],
    primarySelectedId: "a",
    additionalSelectedIds: new Set(["b", "c"]),
  });
  assert.deepEqual([...result.additionalSelectedIds], []);
  assert.equal(result.closePrimary, false);
});

test("toggleSelectAll: partial selection selects the rest (not a deselect)", () => {
  const result = toggleSelectAll({
    displayedFileIds: ["a", "b", "c"],
    primarySelectedId: null,
    additionalSelectedIds: new Set(["a"]),
  });
  assert.deepEqual([...result.additionalSelectedIds].sort(), ["a", "b", "c"]);
  assert.equal(result.closePrimary, false);
});

test("toggleSelectAll: no displayed rows is treated as not-all-selected (no-op select)", () => {
  const result = toggleSelectAll({
    displayedFileIds: [],
    primarySelectedId: null,
    additionalSelectedIds: new Set(),
  });
  assert.deepEqual([...result.additionalSelectedIds], []);
  assert.equal(result.closePrimary, false);
});

test("getSelectAllCheckedState: unchecked when nothing displayed is selected", () => {
  assert.equal(
    getSelectAllCheckedState({ displayedFileIds: ["a", "b"], selectedIds: new Set() }),
    "unchecked",
  );
});

test("getSelectAllCheckedState: checked when every displayed row is selected", () => {
  assert.equal(
    getSelectAllCheckedState({
      displayedFileIds: ["a", "b"],
      selectedIds: new Set(["a", "b", "z"]),
    }),
    "checked",
  );
});

test("getSelectAllCheckedState: indeterminate on partial overlap", () => {
  assert.equal(
    getSelectAllCheckedState({
      displayedFileIds: ["a", "b", "c"],
      selectedIds: new Set(["a"]),
    }),
    "indeterminate",
  );
});

test("getSelectAllCheckedState: unchecked when there are no displayed rows", () => {
  assert.equal(
    getSelectAllCheckedState({ displayedFileIds: [], selectedIds: new Set(["a"]) }),
    "unchecked",
  );
});
