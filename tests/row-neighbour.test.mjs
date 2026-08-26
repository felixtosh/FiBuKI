import test from "node:test";
import assert from "node:assert/strict";
import { getNeighbourRowId } from "../lib/navigation/row-neighbour.js";

const ORDER = ["a", "b", "c"];

test("getNeighbourRowId: the first row has no previous", () => {
  assert.equal(getNeighbourRowId(ORDER, "a", -1), null);
});

test("getNeighbourRowId: the last row has no next", () => {
  assert.equal(getNeighbourRowId(ORDER, "c", 1), null);
});

test("getNeighbourRowId: a middle row returns the adjacent rows", () => {
  assert.equal(getNeighbourRowId(ORDER, "b", -1), "a");
  assert.equal(getNeighbourRowId(ORDER, "b", 1), "c");
});

test("getNeighbourRowId: an unknown current id has no target", () => {
  assert.equal(getNeighbourRowId(ORDER, "zz", -1), null);
  assert.equal(getNeighbourRowId(ORDER, "zz", 1), null);
});

test("getNeighbourRowId: no current id has no target", () => {
  assert.equal(getNeighbourRowId(ORDER, null, 1), null);
  assert.equal(getNeighbourRowId(ORDER, undefined, -1), null);
});

test("getNeighbourRowId: an empty order has no target", () => {
  assert.equal(getNeighbourRowId([], "a", 1), null);
});

test("getNeighbourRowId: the given order wins, not the id values", () => {
  // Sorting by amount can put ids in any order — the helper trusts the list.
  const sortedByAmount = ["c", "a", "b"];
  assert.equal(getNeighbourRowId(sortedByAmount, "c", 1), "a");
  assert.equal(getNeighbourRowId(sortedByAmount, "a", -1), "c");
});
