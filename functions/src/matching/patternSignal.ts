/**
 * One number that changes whenever a user's learned Partner patterns change:
 * the latest patternsUpdatedAt across their Partners, or, for data from before
 * that field existed, the total learned pattern count.
 *
 * Shared by the Transactions page (re-match when it changes mid-session) and
 * catchUpPartnerMatching (re-match on load when it changed since the last
 * run), so the two can never disagree about what counts as a change.
 */

interface PatternSource {
  patternsUpdatedAt?: { toMillis?: () => number } | null;
  learnedPatterns?: unknown[] | null;
}

export function patternSignal(partners: ReadonlyArray<PatternSource>): number {
  const hasUpdatedAt = partners.some((p) => !!p.patternsUpdatedAt);
  if (hasUpdatedAt) {
    return partners.reduce((max, p) => {
      const millis = typeof p.patternsUpdatedAt?.toMillis === "function" ? p.patternsUpdatedAt.toMillis() : 0;
      return Math.max(max, millis);
    }, 0);
  }
  return partners.reduce((sum, p) => sum + (p.learnedPatterns?.length || 0), 0);
}
