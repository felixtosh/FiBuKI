/**
 * Parse URL search params into PartnerFilters object
 *
 * @param {URLSearchParams} searchParams
 * @returns {import("./partner-url-params").PartnerFilters}
 */
function parsePartnerFiltersFromUrl(searchParams) {
  /** @type {import("./partner-url-params").PartnerFilters} */
  const filters = {};

  const hasVatId = searchParams.get("hasVatId");
  if (hasVatId === "true") filters.hasVatId = true;
  if (hasVatId === "false") filters.hasVatId = false;

  const hasIban = searchParams.get("hasIban");
  if (hasIban === "true") filters.hasIban = true;
  if (hasIban === "false") filters.hasIban = false;

  // true = only recurring partners, false = only one-off ones, absent = all.
  const isRecurring = searchParams.get("recurring");
  if (isRecurring === "true") filters.isRecurring = true;
  if (isRecurring === "false") filters.isRecurring = false;

  const country = searchParams.get("country");
  if (country) filters.country = country;

  return filters;
}

/**
 * Build URL search params from PartnerFilters and search string
 *
 * @param {import("./partner-url-params").PartnerFilters} filters
 * @param {string} search
 * @param {string | null} [selectedId]
 * @returns {URLSearchParams}
 */
function buildPartnerSearchParams(filters, search, selectedId) {
  const params = new URLSearchParams();

  if (search) params.set("search", search);
  if (selectedId) params.set("id", selectedId);

  if (filters.hasVatId === true) {
    params.set("hasVatId", "true");
  } else if (filters.hasVatId === false) {
    params.set("hasVatId", "false");
  }

  if (filters.hasIban === true) {
    params.set("hasIban", "true");
  } else if (filters.hasIban === false) {
    params.set("hasIban", "false");
  }

  if (filters.isRecurring === true) {
    params.set("recurring", "true");
  } else if (filters.isRecurring === false) {
    params.set("recurring", "false");
  }

  if (filters.country) {
    params.set("country", filters.country);
  }

  return params;
}

/**
 * Build full URL for partners page with filters
 *
 * @param {import("./partner-url-params").PartnerFilters} filters
 * @param {string} [search]
 * @param {string | null} [selectedId]
 * @returns {string}
 */
function buildPartnerFilterUrl(filters, search, selectedId) {
  const params = buildPartnerSearchParams(filters, search || "", selectedId);
  const queryString = params.toString();
  return queryString ? `/partners?${queryString}` : "/partners";
}

/**
 * Check if any filters are active (excluding search)
 *
 * @param {import("./partner-url-params").PartnerFilters} filters
 * @returns {boolean}
 */
function hasActivePartnerFilters(filters) {
  return !!(
    filters.hasVatId !== undefined ||
    filters.hasIban !== undefined ||
    filters.isRecurring !== undefined ||
    filters.country
  );
}

module.exports = {
  parsePartnerFiltersFromUrl,
  buildPartnerSearchParams,
  buildPartnerFilterUrl,
  hasActivePartnerFilters,
};
