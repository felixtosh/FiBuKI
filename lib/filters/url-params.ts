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
    searchParams.has("documentation")
  );
}

/**
 * Parse URL search params into TransactionFilters object
 */
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
  if (filters.partnerIds && filters.partnerIds.length > 0) count++;
  if (filters.documentationStates !== undefined) count++;
  return count;
}
