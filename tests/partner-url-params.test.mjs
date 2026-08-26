import test from "node:test";
import assert from "node:assert/strict";
import {
  parsePartnerFiltersFromUrl,
  buildPartnerSearchParams,
  buildPartnerFilterUrl,
  hasActivePartnerFilters,
} from "../lib/filters/partner-url-params.js";

/** Parse a query string, serialise it back, and return the resulting query string. */
function roundTrip(queryString, search = "") {
  const filters = parsePartnerFiltersFromUrl(new URLSearchParams(queryString));
  return { filters, query: buildPartnerSearchParams(filters, search).toString() };
}

test("recurring=true parses as the recurring filter and round-trips", () => {
  const { filters, query } = roundTrip("recurring=true");
  assert.equal(filters.isRecurring, true);
  assert.equal(query, "recurring=true");
});

test("recurring=false is the one-off half of the filter, not its absence", () => {
  const { filters, query } = roundTrip("recurring=false");
  assert.equal(filters.isRecurring, false);
  assert.equal(query, "recurring=false");
});

test("a missing recurring param shows all partners, and stays out of the URL", () => {
  const { filters, query } = roundTrip("");
  assert.equal("isRecurring" in filters, false);
  assert.equal(query, "");
});

test("an unrecognised recurring value is ignored", () => {
  const filters = parsePartnerFiltersFromUrl(new URLSearchParams("recurring=maybe"));
  assert.equal("isRecurring" in filters, false);
});

test("the recurring filter round-trips alongside the other filters and the search term", () => {
  const query = "search=anthropic&hasVatId=true&hasIban=false&recurring=true&country=AT";
  const filters = parsePartnerFiltersFromUrl(new URLSearchParams(query));
  assert.deepEqual(filters, {
    hasVatId: true,
    hasIban: false,
    isRecurring: true,
    country: "AT",
  });
  assert.equal(
    buildPartnerFilterUrl(filters, "anthropic"),
    "/partners?search=anthropic&hasVatId=true&hasIban=false&recurring=true&country=AT",
  );
});

test("the selected partner survives the recurring filter", () => {
  const filters = { isRecurring: true };
  assert.equal(
    buildPartnerFilterUrl(filters, "", "partner-1"),
    "/partners?id=partner-1&recurring=true",
  );
});

test("hasActivePartnerFilters counts the recurring filter, in both directions", () => {
  assert.equal(hasActivePartnerFilters({ isRecurring: true }), true);
  assert.equal(hasActivePartnerFilters({ isRecurring: false }), true);
  assert.equal(hasActivePartnerFilters({}), false);
});
