/**
 * "This document's VAT is not claimable" state transitions (#203).
 *
 * Some documents carry a VAT-looking figure that is not deductible Vorsteuer:
 * the 11% on an insurance policy is Versicherungssteuer, and a 100% discount
 * leaves nothing to deduct. The only way to express that used to be typing the
 * rate down to zero, which produced the right figure and destroyed the reason —
 * the record then read exactly like a document that genuinely printed 0%.
 *
 * So the marker is the REASON, from a closed set, and there is no companion
 * boolean: one field cannot disagree with itself. The update objects are built
 * here rather than at the call site, the same way `notInvoiceOps` does it, so a
 * marker set over MCP and a marker set anywhere else land in the same state.
 */

import { FieldValue } from "firebase-admin/firestore";
import type { NonClaimableVatReason } from "../uva/types";

/**
 * The closed set, as data. The union in `uva/types.ts` is the type; this is
 * what a runtime validator and a tool schema enumerate.
 */
export const NON_CLAIMABLE_VAT_REASONS: NonClaimableVatReason[] = [
  "insurance-tax",
  "levy",
  "discount-to-zero",
  "private",
];

/** Note length cap, matching the dismissal-reason cap on the same surface. */
const MAX_NOTE_LENGTH = 500;

export class NonClaimableVatError extends Error {}

/** Narrow an untrusted value to a reason, or refuse it by name. */
export function parseNonClaimableVatReason(value: unknown): NonClaimableVatReason {
  if (typeof value !== "string" || !NON_CLAIMABLE_VAT_REASONS.includes(value as NonClaimableVatReason)) {
    throw new NonClaimableVatError(
      `reason must be one of ${NON_CLAIMABLE_VAT_REASONS.join(", ")}`
    );
  }
  return value as NonClaimableVatReason;
}

function parseNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new NonClaimableVatError("note must be a string");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  if (trimmed.length > MAX_NOTE_LENGTH) {
    throw new NonClaimableVatError(`note must be at most ${MAX_NOTE_LENGTH} characters`);
  }
  return trimmed;
}

/**
 * Mark a file's VAT as not claimable.
 *
 * Nothing extracted is touched. The document really does print that figure and
 * a later re-extraction should keep reading it — what changed is what the
 * derivation is allowed to do with it, which is a judgement about the document,
 * not a correction to it. (That is exactly the difference from
 * `update_file_extraction`, which rewrites what the document is taken to say.)
 */
export function buildMarkVatNotClaimableUpdates(
  reason: unknown,
  note?: unknown
): Record<string, unknown> {
  return {
    vatNotClaimableReason: parseNonClaimableVatReason(reason),
    vatNotClaimableNote: parseNote(note),
    vatNotClaimableAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  };
}

/** Clear the marker: the document's VAT is deductible again. */
export function buildClearVatNotClaimableUpdates(): Record<string, unknown> {
  return {
    vatNotClaimableReason: null,
    vatNotClaimableNote: null,
    vatNotClaimableAt: null,
    updatedAt: FieldValue.serverTimestamp(),
  };
}
