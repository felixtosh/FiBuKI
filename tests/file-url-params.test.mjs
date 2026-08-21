import test from "node:test";
import assert from "node:assert/strict";
import {
  parseFileFiltersFromUrl,
  buildFileSearchParams,
  hasActiveFileFilters,
  countActiveFileFilters,
} from "../lib/filters/file-url-params.js";

/** Parse a query string, serialise it back, and return the resulting query string. */
function roundTrip(queryString, search = "") {
  const filters = parseFileFiltersFromUrl(new URLSearchParams(queryString));
  return { filters, query: buildFileSearchParams(filters, search).toString() };
}

test("notInvoice=false parses as the hide toggle and round-trips", () => {
  const { filters, query } = roundTrip("notInvoice=false");
  assert.equal(filters.isNotInvoice, false);
  assert.equal(query, "notInvoice=false");
});

test("notInvoice=true is unchanged by the third state", () => {
  const { filters, query } = roundTrip("notInvoice=true");
  assert.equal(filters.isNotInvoice, true);
  assert.equal(query, "notInvoice=true");
});

test("a missing notInvoice param means show all, and stays out of the URL", () => {
  const { filters, query } = roundTrip("");
  assert.equal("isNotInvoice" in filters, false);
  assert.equal(query, "");
});

test("an unrecognised notInvoice value is ignored", () => {
  const filters = parseFileFiltersFromUrl(new URLSearchParams("notInvoice=hide"));
  assert.equal("isNotInvoice" in filters, false);
});

test("the hide toggle round-trips alongside the other filters and the search term", () => {
  const query = "search=acme&connected=true&extracted=false&notInvoice=false&partners=p1,p2&type=expense";
  const filters = parseFileFiltersFromUrl(new URLSearchParams(query));
  const rebuilt = buildFileSearchParams(filters, "acme", "file_1");
  assert.equal(rebuilt.get("notInvoice"), "false");
  assert.equal(rebuilt.get("connected"), "true");
  assert.equal(rebuilt.get("extracted"), "false");
  assert.equal(rebuilt.get("partners"), "p1,p2");
  assert.equal(rebuilt.get("type"), "expense");
  assert.equal(rebuilt.get("search"), "acme");
  assert.equal(rebuilt.get("id"), "file_1");
  // Parsing the rebuilt URL yields the same filter object.
  assert.deepEqual(parseFileFiltersFromUrl(rebuilt), filters);
});

test("date params round-trip as ISO strings", () => {
  const filters = parseFileFiltersFromUrl(
    new URLSearchParams("extractedDateFrom=2026-02-01T00:00:00.000Z&extractedDateTo=2026-03-01T00:00:00.000Z"),
  );
  const rebuilt = buildFileSearchParams(filters, "");
  assert.equal(rebuilt.get("extractedDateFrom"), "2026-02-01T00:00:00.000Z");
  assert.equal(rebuilt.get("extractedDateTo"), "2026-03-01T00:00:00.000Z");
});

test("the hide toggle counts as an active filter", () => {
  assert.equal(hasActiveFileFilters({ isNotInvoice: false }), true);
  assert.equal(countActiveFileFilters({ isNotInvoice: false }), 1);
  assert.equal(hasActiveFileFilters({ isNotInvoice: true }), true);
  assert.equal(countActiveFileFilters({ isNotInvoice: true }), 1);
  assert.equal(hasActiveFileFilters({}), false);
  assert.equal(countActiveFileFilters({}), 0);
});

test("clearing the toggle drops it from the badge count and the URL", () => {
  const cleared = { ...parseFileFiltersFromUrl(new URLSearchParams("notInvoice=false")), isNotInvoice: undefined };
  assert.equal(hasActiveFileFilters(cleared), false);
  assert.equal(countActiveFileFilters(cleared), 0);
  assert.equal(buildFileSearchParams(cleared, "").toString(), "");
});
