import test from "node:test";
import assert from "node:assert/strict";
import { invokeLatest } from "../lib/react/latest-callback.js";
import { toggleFileCheckbox } from "../lib/selection/bulk-file-selection.js";

/**
 * A stand-in for the memoised, virtualised row lifecycle in
 * components/ui/data-table: a render paints its handlers only into the rows
 * whose memo comparator says something changed — for VirtualRow, that row's own
 * selection flags — and every other row keeps the handler it painted last.
 *
 * `holdRawClosure: true` is the pre-fix behaviour, where each render hands the
 * rows that render's closure directly. `false` hands them the dispatcher
 * useLatestCallback returns, which is what the fix does.
 */
function mountCheckboxColumn({ rowIds, holdRawClosure }) {
  let additionalSelectedIds = new Set();
  const painted = new Map(); // rowId -> { handler, isSelected }
  const box = { current: null };
  // What useLatestCallback hands out: one dispatcher, reading the box per call.
  const dispatcher = (...args) => invokeLatest(box, args);
  const paintedIdentities = new Set();

  function render() {
    // What the page's component body produces: a handler closed over this
    // render's copy of the selection.
    const snapshot = additionalSelectedIds;
    const handler = (fileId, checked) => {
      const result = toggleFileCheckbox({
        fileId,
        checked,
        primarySelectedId: null,
        additionalSelectedIds: snapshot,
      });
      additionalSelectedIds = result.additionalSelectedIds;
      render();
    };
    // The commit: useLatestCallback swaps this render's closure into the box.
    box.current = handler;

    const handed = holdRawClosure ? handler : dispatcher;
    paintedIdentities.add(handed);

    rowIds.forEach((rowId) => {
      const isSelected = additionalSelectedIds.has(rowId);
      const previous = painted.get(rowId);
      // The comparator: repaint only when this row's own flag moved.
      if (previous && previous.isSelected === isSelected) return;
      painted.set(rowId, { handler: handed, isSelected });
    });
  }

  render();

  return {
    tick(rowId, checked) {
      painted.get(rowId).handler(rowId, checked);
    },
    get selection() {
      return [...additionalSelectedIds].sort();
    },
    get paintedIdentityCount() {
      return paintedIdentities.size;
    },
  };
}

test("a row that skipped a render ticks against the live selection, not its snapshot", () => {
  const table = mountCheckboxColumn({
    rowIds: ["a", "b", "c"],
    holdRawClosure: false,
  });

  // Ticking "a" re-renders only row "a"; "b" and "c" keep the handler they were
  // painted with before anything was selected.
  table.tick("a", true);
  table.tick("b", true);
  table.tick("c", true);

  assert.deepEqual(table.selection, ["a", "b", "c"]);
});

test("unticking one stale row leaves the others selected", () => {
  const table = mountCheckboxColumn({
    rowIds: ["a", "b", "c"],
    holdRawClosure: false,
  });

  table.tick("a", true);
  table.tick("b", true);
  table.tick("c", true);
  table.tick("b", false);

  assert.deepEqual(table.selection, ["a", "c"]);
});

test("pre-fix: the same clicks collapse to a radio group", () => {
  // The behaviour this mechanism exists to prevent (#232): each stale row
  // toggles against the empty set it last rendered with, so its result replaces
  // the selection instead of adding to it.
  const table = mountCheckboxColumn({
    rowIds: ["a", "b", "c"],
    holdRawClosure: true,
  });

  table.tick("a", true);
  table.tick("b", true);
  table.tick("c", true);

  assert.deepEqual(table.selection, ["c"]);
});

test("the identity handed to rows never changes, so the memo still holds", () => {
  const table = mountCheckboxColumn({
    rowIds: ["a", "b", "c"],
    holdRawClosure: false,
  });

  table.tick("a", true);
  table.tick("b", true);

  assert.equal(table.paintedIdentityCount, 1);
});

test("a handler held across renders reads state written after it was painted", () => {
  // The shape of the second handler #232 patched: a row that skipped a render
  // held a shift-click anchor that was still null, so shift-click never entered
  // the range branch and behaved as a plain click.
  let anchor = null;
  const box = { current: null };
  const dispatcher = (...args) => invokeLatest(box, args);

  const render = () => {
    const snapshot = anchor;
    box.current = () => snapshot;
  };

  render();
  const handlerHeldByAStaleRow = dispatcher;
  const rawClosureHeldByAStaleRow = box.current;

  anchor = "row-a";
  render();

  assert.equal(handlerHeldByAStaleRow(), "row-a");
  assert.equal(rawClosureHeldByAStaleRow(), null); // pre-fix
});

test("a dispatcher with nothing in its box is a no-op", () => {
  assert.equal(invokeLatest({ current: null }, ["a", true]), undefined);
});
