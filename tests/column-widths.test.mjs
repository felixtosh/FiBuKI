import test from "node:test";
import assert from "node:assert/strict";
import {
  parseColumnWidths,
  clampColumnWidth,
  sizedColumnWidth,
  columnWidthsToStore,
  readStoredColumnWidths,
  writeStoredColumnWidths,
} from "../lib/tables/column-widths.js";

const limits = { min: 60, max: 400 };

test("parseColumnWidths reads positive widths, rounded", () => {
  assert.deepEqual(parseColumnWidths('{"date":120,"amount":99.6}'), { date: 120, amount: 100 });
});

test("parseColumnWidths reads nothing from nothing or from garbage", () => {
  assert.deepEqual(parseColumnWidths(null), {});
  assert.deepEqual(parseColumnWidths(""), {});
  assert.deepEqual(parseColumnWidths("not json"), {});
  assert.deepEqual(parseColumnWidths("[120]"), {});
  assert.deepEqual(parseColumnWidths("120"), {});
  assert.deepEqual(parseColumnWidths("null"), {});
});

test("parseColumnWidths drops entries that are not positive finite numbers", () => {
  assert.deepEqual(
    parseColumnWidths('{"a":"120","b":-5,"c":0,"d":null,"e":1e400,"f":80}'),
    { f: 80 }
  );
});

test("clampColumnWidth holds a width inside the column's min and max", () => {
  assert.equal(clampColumnWidth(10, limits), 60);
  assert.equal(clampColumnWidth(5000, limits), 400);
  assert.equal(clampColumnWidth(200, limits), 200);
});

test("sizedColumnWidth clamps a sized column and leaves an unsized one to its default", () => {
  assert.equal(sizedColumnWidth({ date: 20 }, "date", limits), 60);
  assert.equal(sizedColumnWidth({ date: 900 }, "date", limits), 400);
  assert.equal(sizedColumnWidth({ date: 150 }, "date", limits), 150);
  assert.equal(sizedColumnWidth({}, "date", limits), undefined);
});

test("columnWidthsToStore clamps the table's columns and rounds", () => {
  const stored = columnWidthsToStore(
    { date: 120.4, select: 200, amount: 10 },
    { date: limits, amount: limits, select: { min: 40, max: 40 }, partner: limits }
  );
  assert.deepEqual(JSON.parse(stored), { date: 120, amount: 60, select: 40 });
});

test("columnWidthsToStore keeps a stored column the table does not show right now", () => {
  // The Files table's Deleted column exists in the deleted-files view only
  const stored = columnWidthsToStore(
    { date: 150 },
    { date: limits, amount: limits },
    { deletedAt: 220, date: 100, amount: 90, broken: -1 }
  );
  // deletedAt is carried over as it is, date takes the new width, amount keeps
  // what was stored, and an unreadable entry is not written back
  assert.deepEqual(JSON.parse(stored), { deletedAt: 220, date: 150, amount: 90 });
});

test("a stored string reads back to what was stored", () => {
  const sizing = { date: 120, amount: 240 };
  const stored = columnWidthsToStore(sizing, { date: limits, amount: limits });
  assert.deepEqual(parseColumnWidths(stored), sizing);
});

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
  };
}

test("readStoredColumnWidths and writeStoredColumnWidths round-trip through storage", () => {
  const storage = memoryStorage();
  writeStoredColumnWidths(() => storage, "k", '{"date":120}');
  assert.equal(readStoredColumnWidths(() => storage, "k"), '{"date":120}');
  assert.equal(readStoredColumnWidths(() => storage, "other"), null);
});

test("storage that throws reads as nothing stored and swallows writes", () => {
  const throwing = () => {
    throw new Error("SecurityError");
  };
  const refusing = {
    getItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
  };
  assert.equal(readStoredColumnWidths(throwing, "k"), null);
  assert.equal(readStoredColumnWidths(() => refusing, "k"), null);
  assert.doesNotThrow(() => writeStoredColumnWidths(throwing, "k", "{}"));
  assert.doesNotThrow(() => writeStoredColumnWidths(() => refusing, "k", "{}"));
});
