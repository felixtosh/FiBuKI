/**
 * The Document chip's values (#250), in display order. Every value selected is
 * the default, so a selection naming all four is normalised away.
 */
const DOCUMENT_TYPE_FILTER_VALUES = ["invoice", "receipt", "other", "unknown"];

/**
 * @param {string[] | undefined} types
 * @returns {import("./file-url-params").FileFilters["documentTypes"]}
 */
function normalizeDocumentTypes(types) {
  if (!types) return undefined;
  const picked = DOCUMENT_TYPE_FILTER_VALUES.filter((t) => types.includes(t));
  return picked.length === DOCUMENT_TYPE_FILTER_VALUES.length ? undefined : picked;
}

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

  // The deleted-files view (#268): deleted rows shown instead of hidden. The
  // param used to mean "deleted alongside live" (includeDeleted); the view
  // replaced that, so old links now open the deleted view.
  const deletedOnly = searchParams.get("deleted");
  if (deletedOnly === "true") filters.deletedOnly = true;

  // Document chip: a comma list of Document Types, "none" for an empty
  // selection, absent for every type.
  const docType = searchParams.get("docType");
  if (docType !== null) {
    const requested = docType === "none" ? [] : docType.split(",");
    const valid = requested.filter((t) => DOCUMENT_TYPE_FILTER_VALUES.includes(t));
    if (docType === "none" || valid.length > 0) {
      const documentTypes = normalizeDocumentTypes(valid);
      if (documentTypes) filters.documentTypes = documentTypes;
    }
  } else {
    // Old links from the retired Status chip options. Document Type `other`
    // has exactly one producer, a File marked not-an-invoice, so "only
    // not-invoices" is Document = Other and "hide not-invoices" is every
    // other type.
    const notInvoice = searchParams.get("notInvoice");
    if (notInvoice === "true") filters.documentTypes = ["other"];
    if (notInvoice === "false") {
      filters.documentTypes = DOCUMENT_TYPE_FILTER_VALUES.filter((t) => t !== "other");
    }
  }

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
  if (
    amountType === "income" ||
    amountType === "expense" ||
    amountType === "not-invoice" ||
    amountType === "undetermined"
  ) {
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

  if (filters.deletedOnly === true) {
    params.set("deleted", "true");
  }

  const documentTypes = normalizeDocumentTypes(filters.documentTypes);
  if (documentTypes) {
    params.set("docType", documentTypes.length > 0 ? documentTypes.join(",") : "none");
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
    searchParams.has("docType") ||
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
    filters.deletedOnly ||
    normalizeDocumentTypes(filters.documentTypes) !== undefined ||
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
  if (filters.deletedOnly) count++;
  if (normalizeDocumentTypes(filters.documentTypes) !== undefined) count++;
  if (filters.uploadedFrom || filters.uploadedTo) count++;
  if (filters.extractedDateFrom || filters.extractedDateTo) count++;
  if (filters.partnerIds && filters.partnerIds.length > 0) count++;
  if (filters.hasPartner !== undefined) count++;
  if (filters.amountType && filters.amountType !== "all") count++;
  return count;
}

module.exports = {
  DOCUMENT_TYPE_FILTER_VALUES,
  normalizeDocumentTypes,
  parseFileFiltersFromUrl,
  buildFileSearchParams,
  buildFileFilterUrl,
  hasFileUrlParams,
  hasActiveFileFilters,
  countActiveFileFilters,
};
