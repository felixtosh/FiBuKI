import test from "node:test";
import assert from "node:assert/strict";
import {
  parseFileFiltersFromUrl,
  buildFileSearchParams,
  hasActiveFileFilters,
  countActiveFileFilters,
  hasFileUrlParams,
} from "../lib/filters/file-url-params.js";

/** Parse a query string, serialise it back, and return the resulting query string. */
function roundTrip(queryString, search = "") {
  const filters = parseFileFiltersFromUrl(new URLSearchParams(queryString));
  return { filters, query: buildFileSearchParams(filters, search).toString() };
}

test("docType round-trips a multi-value selection", () => {
  const { filters, query } = roundTrip("docType=invoice,receipt");
  assert.deepEqual(filters.documentTypes, ["invoice", "receipt"]);
  assert.equal(query, "docType=invoice%2Creceipt");
});

test("a missing docType param means every type, and stays out of the URL", () => {
  const { filters, query } = roundTrip("");
  assert.equal("documentTypes" in filters, false);
  assert.equal(query, "");
});

test("selecting every type is the default and stays out of the URL", () => {
  const params = buildFileSearchParams({ documentTypes: ["unknown", "other", "receipt", "invoice"] }, "");
  assert.equal(params.toString(), "");
  const { filters } = roundTrip("docType=invoice,receipt,other,unknown");
  assert.equal("documentTypes" in filters, false);
});

test("an empty selection round-trips as docType=none", () => {
  const params = buildFileSearchParams({ documentTypes: [] }, "");
  assert.equal(params.get("docType"), "none");
  assert.deepEqual(parseFileFiltersFromUrl(params).documentTypes, []);
});

test("unrecognised docType values are dropped", () => {
  const filters = parseFileFiltersFromUrl(new URLSearchParams("docType=invoice,bogus"));
  assert.deepEqual(filters.documentTypes, ["invoice"]);
  assert.equal("documentTypes" in parseFileFiltersFromUrl(new URLSearchParams("docType=bogus")), false);
});

test("old URL notInvoice=true lands on Document = Other alone", () => {
  const { filters, query } = roundTrip("notInvoice=true");
  assert.deepEqual(filters.documentTypes, ["other"]);
  assert.equal("isNotInvoice" in filters, false);
  assert.equal(query, "docType=other");
});

test("old URL notInvoice=false lands on every Document Type except Other", () => {
  const { filters, query } = roundTrip("notInvoice=false");
  assert.deepEqual(filters.documentTypes, ["invoice", "receipt", "unknown"]);
  assert.equal("isNotInvoice" in filters, false);
  assert.equal(query, "docType=invoice%2Creceipt%2Cunknown");
});

test("an unrecognised notInvoice value is ignored", () => {
  const filters = parseFileFiltersFromUrl(new URLSearchParams("notInvoice=hide"));
  assert.equal("documentTypes" in filters, false);
});

test("docType wins over a stale notInvoice param", () => {
  const filters = parseFileFiltersFromUrl(new URLSearchParams("notInvoice=true&docType=invoice"));
  assert.deepEqual(filters.documentTypes, ["invoice"]);
});

test("the Document selection round-trips alongside the other filters and the search term", () => {
  const query = "search=acme&connected=true&extracted=false&docType=invoice,unknown&partners=p1,p2&type=expense";
  const filters = parseFileFiltersFromUrl(new URLSearchParams(query));
  const rebuilt = buildFileSearchParams(filters, "acme", "file_1");
  assert.equal(rebuilt.get("docType"), "invoice,unknown");
  assert.equal(rebuilt.has("notInvoice"), false);
  assert.equal(rebuilt.get("connected"), "true");
  assert.equal(rebuilt.get("extracted"), "false");
  assert.equal(rebuilt.get("partners"), "p1,p2");
  assert.equal(rebuilt.get("type"), "expense");
  assert.equal(rebuilt.get("search"), "acme");
  assert.equal(rebuilt.get("id"), "file_1");
  // Parsing the rebuilt URL yields the same filter object.
  assert.deepEqual(parseFileFiltersFromUrl(rebuilt), filters);
});

test("partner=matched / partner=unmatched parse as the state filter and round-trip", () => {
  const matched = roundTrip("partner=matched");
  assert.equal(matched.filters.hasPartner, true);
  assert.equal(matched.query, "partner=matched");

  const unmatched = roundTrip("partner=unmatched");
  assert.equal(unmatched.filters.hasPartner, false);
  assert.equal(unmatched.query, "partner=unmatched");
});

test("a missing partner param means any, and stays out of the URL", () => {
  const { filters, query } = roundTrip("");
  assert.equal("hasPartner" in filters, false);
  assert.equal(query, "");
});

test("an unrecognised partner value is ignored", () => {
  const filters = parseFileFiltersFromUrl(new URLSearchParams("partner=true"));
  assert.equal("hasPartner" in filters, false);
});

test("the partner state round-trips alongside picked partner ids", () => {
  const filters = parseFileFiltersFromUrl(new URLSearchParams("partners=p1,p2&partner=unmatched"));
  const rebuilt = buildFileSearchParams(filters, "");
  assert.equal(rebuilt.get("partners"), "p1,p2");
  assert.equal(rebuilt.get("partner"), "unmatched");
  assert.deepEqual(parseFileFiltersFromUrl(rebuilt), filters);
});

test("the partner state counts as an active filter and clears with the rest", () => {
  assert.equal(hasActiveFileFilters({ hasPartner: true }), true);
  assert.equal(countActiveFileFilters({ hasPartner: true }), 1);
  assert.equal(hasActiveFileFilters({ hasPartner: false }), true);
  assert.equal(countActiveFileFilters({ hasPartner: false }), 1);

  const cleared = { ...parseFileFiltersFromUrl(new URLSearchParams("partner=matched")), hasPartner: undefined };
  assert.equal(hasActiveFileFilters(cleared), false);
  assert.equal(buildFileSearchParams(cleared, "").toString(), "");
});

test("date params round-trip as ISO strings", () => {
  const filters = parseFileFiltersFromUrl(
    new URLSearchParams("extractedDateFrom=2026-02-01T00:00:00.000Z&extractedDateTo=2026-03-01T00:00:00.000Z"),
  );
  const rebuilt = buildFileSearchParams(filters, "");
  assert.equal(rebuilt.get("extractedDateFrom"), "2026-02-01T00:00:00.000Z");
  assert.equal(rebuilt.get("extractedDateTo"), "2026-03-01T00:00:00.000Z");
});

test("the Document selection counts as an active filter", () => {
  assert.equal(hasActiveFileFilters({ documentTypes: ["other"] }), true);
  assert.equal(countActiveFileFilters({ documentTypes: ["other"] }), 1);
  assert.equal(countActiveFileFilters({ documentTypes: ["invoice", "receipt"] }), 1);
  assert.equal(hasActiveFileFilters({ documentTypes: [] }), true);
  assert.equal(hasActiveFileFilters({}), false);
  assert.equal(countActiveFileFilters({}), 0);
});

test("clearing the Document selection drops it from the badge count and the URL", () => {
  const cleared = { ...parseFileFiltersFromUrl(new URLSearchParams("notInvoice=false")), documentTypes: undefined };
  assert.equal(hasActiveFileFilters(cleared), false);
  assert.equal(countActiveFileFilters(cleared), 0);
  assert.equal(buildFileSearchParams(cleared, "").toString(), "");
});

test("an old notInvoice URL counts as having filter params", () => {
  assert.equal(hasFileUrlParams(new URLSearchParams("notInvoice=true")), true);
  assert.equal(hasFileUrlParams(new URLSearchParams("docType=other")), true);
});

// --- The deleted-files view (#268) rides the existing ?deleted=true param ---

test("parseFileFiltersFromUrl: deleted=true opens the deleted-files view", () => {
  const filters = parseFileFiltersFromUrl(new URLSearchParams("deleted=true"));
  assert.equal(filters.deletedOnly, true);
  assert.equal(filters.includeDeleted, undefined);
});

test("buildFileSearchParams: the deleted view round-trips", () => {
  const params = buildFileSearchParams({ deletedOnly: true }, "");
  assert.equal(params.get("deleted"), "true");
  const back = parseFileFiltersFromUrl(params);
  assert.equal(back.deletedOnly, true);
});

test("hasActiveFileFilters and countActiveFileFilters see the deleted view", () => {
  assert.equal(hasActiveFileFilters({ deletedOnly: true }), true);
  assert.equal(countActiveFileFilters({ deletedOnly: true }), 1);
});

test("Type not-invoice round-trips through the URL (#519)", () => {
  const params = buildFileSearchParams({ amountType: "not-invoice" }, "");
  assert.equal(params.get("type"), "not-invoice");
  assert.equal(parseFileFiltersFromUrl(params).amountType, "not-invoice");
});
