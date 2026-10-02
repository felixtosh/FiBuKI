/**
 * Which of a Transaction's stored Partner suggestions are shown, and in what
 * order. One function for every surface that shows them.
 *
 * The list's Partner cell and the detail panel used to read the same
 * `partnerSuggestions` two ways: the cell took the first one it could
 * resolve, while the panel also dropped Partners the user had removed from
 * this Transaction and Global Partners the user already has a copy of, and
 * sorted by confidence. A row could therefore show a suggestion the panel did
 * not recognise, and the panel, seeing none, ran partner matching on open and
 * rewrote the row. Both now ask this.
 *
 * Nothing here scores. The suggestions and their confidence come from the
 * server (CLAUDE.md, server-side scoring only); this only decides which of
 * them still apply for this user.
 */

import type { Transaction } from "@/types/transaction";
import type { UserPartner, GlobalPartner, PartnerSuggestion } from "@/types/partner";

export interface ResolvedPartnerSuggestion extends PartnerSuggestion {
  partner: UserPartner | GlobalPartner;
}

/**
 * Build once per partner list, call per Transaction: the lookups are maps, so
 * a table can resolve every row without scanning the partner lists each time.
 */
export function createPartnerSuggestionResolver(
  userPartners: UserPartner[],
  globalPartners: GlobalPartner[],
): (transaction: Pick<Transaction, "id" | "partnerSuggestions">) => ResolvedPartnerSuggestion[] {
  const users = new Map(userPartners.map((p) => [p.id, p]));
  const globals = new Map(globalPartners.map((p) => [p.id, p]));
  const copiedGlobals = new Set(
    userPartners.map((p) => p.globalPartnerId).filter((id): id is string => !!id),
  );

  return (transaction) => {
    const stored = transaction.partnerSuggestions;
    if (!stored || stored.length === 0) return [];

    const results: ResolvedPartnerSuggestion[] = [];
    const seen = new Set<string>();
    for (const suggestion of stored) {
      if (seen.has(suggestion.partnerId)) continue;
      const partner =
        suggestion.partnerType === "user" ? users.get(suggestion.partnerId) : globals.get(suggestion.partnerId);
      if (!partner) continue;

      // The user took this Transaction away from this Partner by hand.
      if (
        suggestion.partnerType === "user" &&
        (partner as UserPartner).manualRemovals?.some((r) => r.transactionId === transaction.id)
      ) {
        continue;
      }
      // The user has their own copy of this Global Partner; the copy is the
      // one that applies.
      if (suggestion.partnerType === "global" && copiedGlobals.has(suggestion.partnerId)) continue;

      seen.add(suggestion.partnerId);
      results.push({ ...suggestion, partner });
    }
    // Highest confidence first; a stable sort keeps the server's order on ties.
    return results.sort((a, b) => b.confidence - a.confidence);
  };
}
