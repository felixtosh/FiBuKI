import test from "node:test";
import assert from "node:assert/strict";
import {
  toggleFileCheckbox,
  toggleSelectAll,
  getSelectAllCheckedState,
  resolveSelectionChange,
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

// resolveSelectionChange covers the table's row-click/modifier-click wiring -
// the level where the radio-group regression actually lived. A resulting Set
// of size 1 can come from a plain click OR from ctrl/cmd-click/shift-click
// (deselecting down to one, or the first modifier-click from empty); only
// `isPlainClick` tells them apart, never the Set's size.

test("resolveSelectionChange: a plain click replaces the whole selection with the clicked row", () => {
  const result = resolveSelectionChange({
    newSelectedIds: new Set(["b"]),
    isPlainClick: true,
    primarySelectedId: "a",
  });
  assert.equal(result.primaryId, "b");
  assert.deepEqual([...result.additionalSelectedIds], []);
});

test("resolveSelectionChange: ctrl-click accumulates a second row instead of clearing the first", () => {
  // Regression for the reported bug: ticking/ctrl-clicking a second row must
  // not clear whatever was already selected.
  const result = resolveSelectionChange({
    newSelectedIds: new Set(["a", "b"]),
    isPlainClick: false,
    primarySelectedId: "a",
  });
  assert.equal(result.primaryId, "a");
  assert.deepEqual([...result.additionalSelectedIds], ["b"]);
});

test("resolveSelectionChange: ctrl-click deselecting down to one row stays a bulk selection, not a primary click", () => {
  // The actual bug: the table can report a Set of size 1 from a modifier
  // click (here, two of three ctrl-selected rows just got toggled off). That
  // must not be mistaken for "user plain-clicked a new row" or it silently
  // wipes the rest of the bulk selection and hijacks the detail panel.
  const result = resolveSelectionChange({
    newSelectedIds: new Set(["b"]),
    isPlainClick: false,
    primarySelectedId: "a",
  });
  assert.equal(result.primaryId, "a");
  assert.deepEqual([...result.additionalSelectedIds], ["b"]);
});

test("resolveSelectionChange: the first ctrl-click from an empty selection opens the detail panel on that row", () => {
  const result = resolveSelectionChange({
    newSelectedIds: new Set(["a"]),
    isPlainClick: false,
    primarySelectedId: null,
    clickedRowId: "a",
    isRangeClick: false,
  });
  assert.equal(result.primaryId, "a");
  assert.deepEqual([...result.additionalSelectedIds], []);
});

test("resolveSelectionChange: a ctrl-click with a panel already open does NOT move it", () => {
  const result = resolveSelectionChange({
    newSelectedIds: new Set(["a", "b"]),
    isPlainClick: false,
    primarySelectedId: "a",
    clickedRowId: "b",
    isRangeClick: false,
  });
  assert.equal(result.primaryId, "a");
  assert.deepEqual([...result.additionalSelectedIds], ["b"]);
});

test("resolveSelectionChange: a ctrl-click that DESELECTS a row promotes nothing", () => {
  // The clicked row is not in the resulting set, so there is nothing to show.
  const result = resolveSelectionChange({
    newSelectedIds: new Set(["a"]),
    isPlainClick: false,
    primarySelectedId: null,
    clickedRowId: "b",
    isRangeClick: false,
  });
  assert.equal(result.primaryId, null);
  assert.deepEqual([...result.additionalSelectedIds], ["a"]);
});

test("resolveSelectionChange: shift-click promotes the clicked end of its range to primary", () => {
  // Decided 2026-09-10: a shift-click moves the detail panel to the row it
  // was made on, and the rest of the range is the bulk selection.
  const result = resolveSelectionChange({
    newSelectedIds: new Set(["a", "b", "c"]),
    isPlainClick: false,
    primarySelectedId: "a",
    clickedRowId: "c",
    isRangeClick: true,
  });
  assert.equal(result.primaryId, "c");
  assert.deepEqual([...result.additionalSelectedIds].sort(), ["a", "b"]);
});

test("resolveSelectionChange: shift-click collapsing to one row promotes that row", () => {
  const result = resolveSelectionChange({
    newSelectedIds: new Set(["c"]),
    isPlainClick: false,
    primarySelectedId: "a",
    clickedRowId: "c",
    isRangeClick: true,
  });
  assert.equal(result.primaryId, "c");
  assert.deepEqual([...result.additionalSelectedIds], []);
});

test("resolveSelectionChange: ctrl-click deselecting the last selected row clears everything", () => {
  const result = resolveSelectionChange({
    newSelectedIds: new Set(),
    isPlainClick: false,
    primarySelectedId: "a",
  });
  assert.equal(result.primaryId, null);
  assert.deepEqual([...result.additionalSelectedIds], []);
});

test("resolveSelectionChange: modifier-click selection keeps the primary itself out of the additional set", () => {
  const result = resolveSelectionChange({
    newSelectedIds: new Set(["a", "b", "c"]),
    isPlainClick: false,
    primarySelectedId: "a",
  });
  assert.equal(result.primaryId, "a");
  assert.deepEqual([...result.additionalSelectedIds].sort(), ["b", "c"]);
});
