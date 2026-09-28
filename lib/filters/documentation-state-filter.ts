import type { DocumentationState } from "@/types/transaction";
import { describeDocumentationState } from "@/lib/documents/document-type-presentation";

/**
 * The Documentation filter on the Transactions list (#249).
 *
 * Multi-select, every state selected by default, so narrowing is unchecking
 * what you do not want to see: the useful questions ("backed by a receipt but
 * no deductible invoice?") are often exclusions, which a single-select chip
 * cannot express.
 *
 * `undefined` is the default (all five). An empty array is a real selection
 * that shows nothing. The order is the chip's order.
 */
export const ALL_DOCUMENTATION_STATES: readonly DocumentationState[] = [
  "invoice",
  "receipt-only",
  "no-receipt-category",
  "undocumented",
  "unknown",
];

/**
 * Canonical order, valid values only, and `undefined` when all five are
 * selected, so the default never reaches the URL or the active-filter count.
 */
export function normalizeDocumentationStates(
  states: readonly string[] | undefined
): DocumentationState[] | undefined {
  if (!states) return undefined;
  const wanted = new Set(states);
  const normalized = ALL_DOCUMENTATION_STATES.filter((s) => wanted.has(s));
  return normalized.length === ALL_DOCUMENTATION_STATES.length ? undefined : normalized;
}

/**
 * Whether a transaction's Documentation State is in the selection. An absent
 * state resolves the way the badge resolves it, to `unknown` (never checked),
 * never to `undocumented`.
 */
export function matchesDocumentationStates(
  state: DocumentationState | null | undefined,
  selected: readonly DocumentationState[] | undefined
): boolean {
  if (!selected) return true;
  return selected.includes(describeDocumentationState(state).state);
}
