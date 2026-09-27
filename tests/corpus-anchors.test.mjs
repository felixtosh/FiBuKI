import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const guardPath = require.resolve("../scripts/check-corpus-anchors.js");
const { rulesTrippedBy } = require(guardPath);

/**
 * Every sample is assembled at runtime, for the same reason the guard builds
 * its patterns that way: this file is tracked, so a literal anchor here would
 * fail the guard it is testing. The numbers are invented.
 */
const paperless = (digits) => ["paperless", "ap", digits].join("-");
const fibu = (separator) => ["FIBU", "20260109"].join(separator) + "-8624";

test("a Paperless id outside 1000-1999 is caught (#343)", () => {
  for (const digits of ["2003", "987", "42", "20250"]) {
    assert.deepEqual(rulesTrippedBy(paperless(digits)), ["Paperless document id"], digits);
  }
});

test("a Paperless id inside 1000-1999 is still caught", () => {
  for (const digits of ["1004", "1097"]) {
    assert.deepEqual(rulesTrippedBy(paperless(digits)), ["Paperless document id"], digits);
  }
});

test("the widened FiBu separator from #184 still catches all three forms", () => {
  for (const separator of [" ", "_", "-"]) {
    assert.deepEqual(rulesTrippedBy(fibu(separator)), ["FiBu document reference"], separator);
  }
});

test("a fixture named for what it is passes", () => {
  assert.deepEqual(rulesTrippedBy("f-vendor-invoice-11pct"), []);
});

test("the guard does not flag itself", () => {
  const lines = fs.readFileSync(guardPath, "utf8").split("\n");
  const flagged = lines.filter((line) => rulesTrippedBy(line).length > 0);
  assert.deepEqual(flagged, []);
});
