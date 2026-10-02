import { TransactionFilters } from "@/types/transaction";
import { normalizeDocumentationStates } from "@/lib/filters/documentation-state-filter";

const FILTERS_STORAGE_KEY = "transactionFilters";
const SEARCH_STORAGE_KEY = "transactionSearch";

/**
 * Serializable version of filters for localStorage
 * Note: importId is NOT persisted - it's only used for deep links from import history
 */
interface StoredFilters {
  isComplete?: boolean;
  dateFrom?: string; // ISO string
  dateTo?: string; // ISO string
  amountType?: "income" | "expense" | "all";
  sourceId?: string;
  partnerIds?: string[];
  hasPartner?: boolean;
  documentationStates?: string[];
}

/**
 * Save filters and search to localStorage
 */
export function saveFiltersToStorage(
  filters: TransactionFilters,
  search: string
): void {
  const stored: StoredFilters = {};
  // Note: importId is intentionally NOT saved - it's a deep link filter only
  if (filters.isComplete !== undefined) stored.isComplete = filters.isComplete;
  if (filters.dateFrom) stored.dateFrom = filters.dateFrom.toISOString();
  if (filters.dateTo) stored.dateTo = filters.dateTo.toISOString();
  if (filters.amountType && filters.amountType !== "all")
    stored.amountType = filters.amountType;
  if (filters.sourceId) stored.sourceId = filters.sourceId;
  if (filters.partnerIds && filters.partnerIds.length > 0) {
    stored.partnerIds = filters.partnerIds;
  }
  if (filters.hasPartner !== undefined) stored.hasPartner = filters.hasPartner;
  if (filters.documentationStates) {
    stored.documentationStates = filters.documentationStates;
  }

  localStorage.setItem(FILTERS_STORAGE_KEY, JSON.stringify(stored));
  localStorage.setItem(SEARCH_STORAGE_KEY, search);
}

/**
 * Load filters and search from localStorage
 */
export function loadFiltersFromStorage(): {
  filters: TransactionFilters;
  search: string;
} {
  const filters: TransactionFilters = {};
  const search = localStorage.getItem(SEARCH_STORAGE_KEY) || "";

  try {
    const stored = localStorage.getItem(FILTERS_STORAGE_KEY);
    if (stored) {
      const parsed: StoredFilters = JSON.parse(stored);
      // Note: importId is NOT loaded from storage - it's a deep link filter only
      if (parsed.isComplete !== undefined) filters.isComplete = parsed.isComplete;
      if (parsed.dateFrom) filters.dateFrom = new Date(parsed.dateFrom);
      if (parsed.dateTo) filters.dateTo = new Date(parsed.dateTo);
      if (parsed.amountType) filters.amountType = parsed.amountType;
      if (parsed.sourceId) filters.sourceId = parsed.sourceId;
      if (parsed.partnerIds && parsed.partnerIds.length > 0) {
        filters.partnerIds = parsed.partnerIds;
      }
      if (parsed.hasPartner !== undefined) filters.hasPartner = parsed.hasPartner;
      const documentationStates = normalizeDocumentationStates(parsed.documentationStates);
      if (documentationStates) filters.documentationStates = documentationStates;
    }
  } catch {
    // Ignore parse errors
  }

  return { filters, search };
}

/**
 * Build URL search params string from filters and search
 */
export function buildSearchParamsString(
  filters: TransactionFilters,
  search: string
): string {
  const params = new URLSearchParams();

  if (search) params.set("search", search);
  if (filters.importId) params.set("importId", filters.importId);
  if (filters.isComplete !== undefined)
    params.set("isComplete", String(filters.isComplete));
  if (filters.dateFrom) params.set("dateFrom", filters.dateFrom.toISOString());
  if (filters.dateTo) params.set("dateTo", filters.dateTo.toISOString());
  if (filters.amountType && filters.amountType !== "all")
    params.set("amountType", filters.amountType);
  if (filters.sourceId) params.set("sourceId", filters.sourceId);
  if (filters.partnerIds && filters.partnerIds.length > 0) {
    params.set("partnerIds", filters.partnerIds.join(","));
  }
  if (filters.hasPartner !== undefined) params.set("hasPartner", String(filters.hasPartner));
  if (filters.documentationStates) {
    params.set("documentation", filters.documentationStates.join(","));
  }

  return params.toString();
}

/**
 * Check if URL has any filter or search params
 */
export function hasUrlParams(searchParams: URLSearchParams): boolean {
  return (
    searchParams.has("search") ||
    searchParams.has("importId") ||
    searchParams.has("isComplete") ||
    searchParams.has("dateFrom") ||
    searchParams.has("dateTo") ||
    searchParams.has("amountType") ||
    searchParams.has("sourceId") ||
    searchParams.has("partnerId") ||
    searchParams.has("partnerIds") ||
    searchParams.has("hasPartner") ||
    searchParams.has("documentation")
  );
}

/**
 * Parse URL search params into TransactionFilters object
 */
/**
 * The query string with only what the filters read: everything except the
 * selected row (`id`) and an open overlay (`connect`). Memoise filter parsing
 * on this, not on the whole searchParams object: selecting a row changes the
 * query, and a fresh filters object on every selection re-filtered and
 * re-sorted the whole list and re-rendered every visible row.
 */
export function filterQueryKey(searchParams: URLSearchParams): string {
  const params = new URLSearchParams(searchParams.toString());
  params.delete("id");
  params.delete("connect");
  params.sort();
  return params.toString();
}

export function parseFiltersFromUrl(
  searchParams: URLSearchParams
): TransactionFilters {
  const filters: TransactionFilters = {};

  const importId = searchParams.get("importId");
  if (importId) filters.importId = importId;

  const isComplete = searchParams.get("isComplete");
  if (isComplete === "true") filters.isComplete = true;
  if (isComplete === "false") filters.isComplete = false;

  const dateFrom = searchParams.get("dateFrom");
  if (dateFrom) filters.dateFrom = new Date(dateFrom);

  const dateTo = searchParams.get("dateTo");
  if (dateTo) filters.dateTo = new Date(dateTo);

  const amountType = searchParams.get("amountType");
  if (amountType === "income" || amountType === "expense") {
    filters.amountType = amountType;
  }

  const sourceId = searchParams.get("sourceId");
  if (sourceId) filters.sourceId = sourceId;

  const partnerId = searchParams.get("partnerId");
  const partnerIds = searchParams.get("partnerIds");
  if (partnerIds) {
    filters.partnerIds = partnerIds.split(",").map((id) => id.trim()).filter(Boolean);
  } else if (partnerId) {
    filters.partnerIds = [partnerId];
    filters.partnerId = partnerId;
  }

  // "No partner assigned" (#519). A specific partner pick wins over it.
  const hasPartner = searchParams.get("hasPartner");
  if (hasPartner === "true") filters.hasPartner = true;
  if (hasPartner === "false") filters.hasPartner = false;

  // Present but empty is the empty selection, not the default.
  const documentation = searchParams.get("documentation");
  if (documentation !== null) {
    const documentationStates = normalizeDocumentationStates(
      documentation.split(",").map((s) => s.trim()).filter(Boolean)
    );
    if (documentationStates) filters.documentationStates = documentationStates;
  }

  return filters;
}

/**
 * Build URL with filter params from TransactionFilters object
 */
export function buildFilterUrl(
  basePath: string,
  filters: TransactionFilters
): string {
  const params = new URLSearchParams();

  if (filters.importId) params.set("importId", filters.importId);
  if (filters.isComplete !== undefined)
    params.set("isComplete", String(filters.isComplete));
  if (filters.dateFrom) params.set("dateFrom", filters.dateFrom.toISOString());
  if (filters.dateTo) params.set("dateTo", filters.dateTo.toISOString());
  if (filters.amountType && filters.amountType !== "all")
    params.set("amountType", filters.amountType);
  if (filters.sourceId) params.set("sourceId", filters.sourceId);
  if (filters.partnerIds && filters.partnerIds.length > 0) {
    params.set("partnerIds", filters.partnerIds.join(","));
  }
  if (filters.hasPartner !== undefined) params.set("hasPartner", String(filters.hasPartner));
  if (filters.documentationStates) {
    params.set("documentation", filters.documentationStates.join(","));
  }

  const queryString = params.toString();
  return queryString ? `${basePath}?${queryString}` : basePath;
}

/**
 * Check if any filters are active (excluding search)
 */
export function hasActiveFilters(filters: TransactionFilters): boolean {
  return !!(
    filters.importId ||
    filters.isComplete !== undefined ||
    filters.dateFrom ||
    filters.dateTo ||
    (filters.amountType && filters.amountType !== "all") ||
    filters.sourceId ||
    (filters.partnerIds && filters.partnerIds.length > 0) ||
    filters.hasPartner !== undefined ||
    filters.documentationStates !== undefined
  );
}

/**
 * Count number of active filters
 */
export function countActiveFilters(filters: TransactionFilters): number {
  let count = 0;
  if (filters.importId) count++;
  if (filters.isComplete !== undefined) count++;
  if (filters.dateFrom || filters.dateTo) count++;
  if (filters.amountType && filters.amountType !== "all") count++;
  if (filters.sourceId) count++;
  // One Partner chip carries both the partner picks and "No partner assigned".
  if ((filters.partnerIds && filters.partnerIds.length > 0) || filters.hasPartner !== undefined) count++;
  if (filters.documentationStates !== undefined) count++;
  return count;
}
