/**
 * Parse URL search params into FileFilters object
 *
 * @param {URLSearchParams} searchParams
 * @returns {import("./file-url-params").FileFilters}
 */
function parseFileFiltersFromUrl(searchParams) {
  /** @type {import("./file-url-params").FileFilters} */
  const filters = {};

  const hasConnections = searchParams.get("connected");
  if (hasConnections === "true") filters.hasConnections = true;
  if (hasConnections === "false") filters.hasConnections = false;

  const extractionComplete = searchParams.get("extracted");
  if (extractionComplete === "true") filters.extractionComplete = true;
  if (extractionComplete === "false") filters.extractionComplete = false;

  const includeDeleted = searchParams.get("deleted");
  if (includeDeleted === "true") filters.includeDeleted = true;

  // true = only not-invoices, false = hide not-invoices, absent = show all.
  const isNotInvoice = searchParams.get("notInvoice");
  if (isNotInvoice === "true") filters.isNotInvoice = true;
  if (isNotInvoice === "false") filters.isNotInvoice = false;

  const uploadedFrom = searchParams.get("uploadedFrom");
  if (uploadedFrom) filters.uploadedFrom = new Date(uploadedFrom);

  const uploadedTo = searchParams.get("uploadedTo");
  if (uploadedTo) filters.uploadedTo = new Date(uploadedTo);

  const extractedDateFrom = searchParams.get("extractedDateFrom");
  if (extractedDateFrom) filters.extractedDateFrom = new Date(extractedDateFrom);

  const extractedDateTo = searchParams.get("extractedDateTo");
  if (extractedDateTo) filters.extractedDateTo = new Date(extractedDateTo);

  const partnerIds = searchParams.get("partners");
  if (partnerIds) filters.partnerIds = partnerIds.split(",");

  // matched = has a partner, unmatched = has none, absent = any.
  const hasPartner = searchParams.get("partner");
  if (hasPartner === "matched") filters.hasPartner = true;
  if (hasPartner === "unmatched") filters.hasPartner = false;

  const amountType = searchParams.get("type");
  if (amountType === "income" || amountType === "expense") {
    filters.amountType = amountType;
  }

  return filters;
}

/**
 * Build URL search params from FileFilters and search string
 *
 * @param {import("./file-url-params").FileFilters} filters
 * @param {string} search
 * @param {string | null} [selectedId]
 * @returns {URLSearchParams}
 */
function buildFileSearchParams(filters, search, selectedId) {
  const params = new URLSearchParams();

  if (search) params.set("search", search);
  if (selectedId) params.set("id", selectedId);

  if (filters.hasConnections === true) {
    params.set("connected", "true");
  } else if (filters.hasConnections === false) {
    params.set("connected", "false");
  }

  if (filters.extractionComplete === true) {
    params.set("extracted", "true");
  } else if (filters.extractionComplete === false) {
    params.set("extracted", "false");
  }

  if (filters.includeDeleted === true) {
    params.set("deleted", "true");
  }

  if (filters.isNotInvoice === true) {
    params.set("notInvoice", "true");
  } else if (filters.isNotInvoice === false) {
    params.set("notInvoice", "false");
  }

  if (filters.uploadedFrom) {
    params.set("uploadedFrom", filters.uploadedFrom.toISOString());
  }

  if (filters.uploadedTo) {
    params.set("uploadedTo", filters.uploadedTo.toISOString());
  }

  if (filters.extractedDateFrom) {
    params.set("extractedDateFrom", filters.extractedDateFrom.toISOString());
  }

  if (filters.extractedDateTo) {
    params.set("extractedDateTo", filters.extractedDateTo.toISOString());
  }

  if (filters.partnerIds && filters.partnerIds.length > 0) {
    params.set("partners", filters.partnerIds.join(","));
  }

  if (filters.hasPartner === true) {
    params.set("partner", "matched");
  } else if (filters.hasPartner === false) {
    params.set("partner", "unmatched");
  }

  if (filters.amountType && filters.amountType !== "all") {
    params.set("type", filters.amountType);
  }

  return params;
}

/**
 * Build full URL for files page with filters
 *
 * @param {import("./file-url-params").FileFilters} filters
 * @param {string} [search]
 * @param {string | null} [selectedId]
 * @returns {string}
 */
function buildFileFilterUrl(filters, search, selectedId) {
  const params = buildFileSearchParams(filters, search || "", selectedId);
  const queryString = params.toString();
  return queryString ? `/files?${queryString}` : "/files";
}

/**
 * Check if URL has any filter params (excluding search and id)
 *
 * @param {URLSearchParams} searchParams
 * @returns {boolean}
 */
function hasFileUrlParams(searchParams) {
  return (
    searchParams.has("connected") ||
    searchParams.has("extracted") ||
    searchParams.has("deleted") ||
    searchParams.has("notInvoice") ||
    searchParams.has("uploadedFrom") ||
    searchParams.has("uploadedTo") ||
    searchParams.has("extractedDateFrom") ||
    searchParams.has("extractedDateTo") ||
    searchParams.has("partners") ||
    searchParams.has("partner") ||
    searchParams.has("type")
  );
}

/**
 * Check if any filters are active (excluding search)
 *
 * @param {import("./file-url-params").FileFilters} filters
 * @returns {boolean}
 */
function hasActiveFileFilters(filters) {
  return !!(
    filters.hasConnections !== undefined ||
    filters.extractionComplete !== undefined ||
    filters.includeDeleted ||
    filters.isNotInvoice !== undefined ||
    filters.uploadedFrom ||
    filters.uploadedTo ||
    filters.extractedDateFrom ||
    filters.extractedDateTo ||
    (filters.partnerIds && filters.partnerIds.length > 0) ||
    filters.hasPartner !== undefined ||
    (filters.amountType && filters.amountType !== "all")
  );
}

/**
 * Count number of active filters
 *
 * @param {import("./file-url-params").FileFilters} filters
 * @returns {number}
 */
function countActiveFileFilters(filters) {
  let count = 0;
  if (filters.hasConnections !== undefined) count++;
  if (filters.extractionComplete !== undefined) count++;
  if (filters.includeDeleted) count++;
  if (filters.isNotInvoice !== undefined) count++;
  if (filters.uploadedFrom || filters.uploadedTo) count++;
  if (filters.extractedDateFrom || filters.extractedDateTo) count++;
  if (filters.partnerIds && filters.partnerIds.length > 0) count++;
  if (filters.hasPartner !== undefined) count++;
  if (filters.amountType && filters.amountType !== "all") count++;
  return count;
}

module.exports = {
  parseFileFiltersFromUrl,
  buildFileSearchParams,
  buildFileFilterUrl,
  hasFileUrlParams,
  hasActiveFileFilters,
  countActiveFileFilters,
};
