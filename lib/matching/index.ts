/**
 * Partner matching utilities
 */

export {
  normalizeUrl,
  extractDomain,
  extractRootDomain,
  urlsMatch,
  rootDomainsMatch,
  isValidUrl,
} from "./url-normalizer";

export {
  calculateSimilarity,
  normalizeCompanyName,
  calculateCompanyNameSimilarity,
  findBestNameMatch,
  vatIdsMatch,
} from "./fuzzy-match";

export {
  globMatch,
  shouldAutoApply,
  getConfidenceTier,
  getConfidenceColor,
  getSourceLabel,
} from "./partner-matcher";

/**
 * Transaction matching display helpers (file to transaction)
 */
export {
  TRANSACTION_MATCH_CONFIG,
  shouldAutoMatchTransaction,
  getTransactionMatchConfidenceTier,
  getTransactionMatchConfidenceColor,
  getTransactionMatchSourceLabel,
  getTransactionMatchSourceIcon,
} from "./transaction-matcher";

/**
 * Automation definitions (for registry and UI)
 */
export {
  PARTNER_MATCH_CONFIG,
  CATEGORY_MATCH_CONFIG,
  PARTNER_MATCHING_AUTOMATIONS,
  FILE_MATCHING_AUTOMATIONS,
  FIND_PARTNER_PIPELINE,
  FIND_FILE_PIPELINE,
  ALL_PIPELINES,
} from "./automation-defs";
