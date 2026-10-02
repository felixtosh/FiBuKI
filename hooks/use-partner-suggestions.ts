"use client";

import { useMemo } from "react";
import { Transaction } from "@/types/transaction";
import { TaxFile } from "@/types/file";
import { UserPartner, GlobalPartner, PartnerSuggestion, PartnerMatchResult } from "@/types/partner";
import { normalizeIban } from "@/lib/import/deduplication";
import { calculateCompanyNameSimilarity, vatIdsMatch } from "@/lib/matching/fuzzy-match";
import { createPartnerSuggestionResolver } from "@/lib/partners/partner-suggestions";

export interface PartnerSuggestionWithDetails extends PartnerSuggestion {
  partner: UserPartner | GlobalPartner;
}

/**
 * Hook to get partner suggestions for a transaction with full partner details.
 * Uses server-side stored suggestions (transaction.partnerSuggestions).
 * All pattern matching is done on the backend for consistency.
 */
export function usePartnerSuggestions(
  transaction: Transaction | null,
  userPartners: UserPartner[],
  globalPartners: GlobalPartner[]
): PartnerSuggestionWithDetails[] {
  // Shared with the list's Partner cell, so the row and the panel always show
  // the same suggestions (lib/partners/partner-suggestions.ts).
  const resolve = useMemo(
    () => createPartnerSuggestionResolver(userPartners, globalPartners),
    [userPartners, globalPartners]
  );
  return useMemo(() => (transaction ? resolve(transaction) : []), [transaction, resolve]);
}

/**
 * Get the assigned partner for a transaction
 */
export function useAssignedPartner(
  transaction: Transaction | null,
  userPartners: UserPartner[],
  globalPartners: GlobalPartner[]
): (UserPartner | GlobalPartner) | null {
  return useMemo(() => {
    if (!transaction?.partnerId || !transaction?.partnerType) {
      return null;
    }

    if (transaction.partnerType === "user") {
      return userPartners.find((p) => p.id === transaction.partnerId) || null;
    } else {
      return globalPartners.find((p) => p.id === transaction.partnerId) || null;
    }
  }, [transaction, userPartners, globalPartners]);
}

/**
 * Match a file's extracted data against a single partner
 */
function matchFileToPartner(
  file: TaxFile,
  partner: UserPartner | GlobalPartner,
  partnerType: "user" | "global"
): PartnerMatchResult | null {
  let bestMatch: PartnerMatchResult | null = null;

  // 1. IBAN match (100% confidence) - Highest priority
  if (file.extractedIban && partner.ibans && partner.ibans.length > 0) {
    const fileIban = normalizeIban(file.extractedIban);
    for (const iban of partner.ibans) {
      if (normalizeIban(iban) === fileIban) {
        return {
          partnerId: partner.id,
          partnerType,
          partnerName: partner.name,
          confidence: 100,
          source: "iban",
        };
      }
    }
  }

  // 2. VAT ID match (95% confidence)
  if (file.extractedVatId && partner.vatId) {
    if (vatIdsMatch(file.extractedVatId, partner.vatId)) {
      return {
        partnerId: partner.id,
        partnerType,
        partnerName: partner.name,
        confidence: 95,
        source: "vatId",
      };
    }
  }

  // 3. Name matching (60-90% confidence)
  if (file.extractedPartner) {
    const namesToCheck = [partner.name, ...(partner.aliases || []).filter((a) => !a.includes("*"))];

    for (const name of namesToCheck) {
      const similarity = calculateCompanyNameSimilarity(file.extractedPartner, name);

      if (similarity >= 60) {
        // Scale 60-100 similarity to 60-90 confidence
        const confidence = Math.min(90, 60 + ((similarity - 60) * 30) / 40);
        const match: PartnerMatchResult = {
          partnerId: partner.id,
          partnerType,
          partnerName: partner.name,
          confidence: Math.round(confidence),
          source: "name",
        };
        if (!bestMatch || match.confidence > bestMatch.confidence) {
          bestMatch = match;
        }
      }
    }
  }

  return bestMatch;
}

/**
 * Hook to get partner suggestions for a file based on extracted data
 * Matches using:
 * 1. IBAN match (100% confidence)
 * 2. VAT ID match (95% confidence)
 * 3. Name fuzzy match (60-90% confidence)
 */
export function useFilePartnerSuggestions(
  file: TaxFile | null,
  userPartners: UserPartner[],
  globalPartners: GlobalPartner[]
): PartnerSuggestionWithDetails[] {
  return useMemo(() => {
    if (!file) return [];
    // If file already has a partner assigned, no suggestions needed
    if (file.partnerId) return [];
    // If no extracted data to match on, return empty
    if (!file.extractedPartner && !file.extractedVatId && !file.extractedIban) {
      return [];
    }

    const results: PartnerSuggestionWithDetails[] = [];
    const seenPartnerIds = new Set<string>();

    // Match against user partners first
    for (const partner of userPartners) {
      const match = matchFileToPartner(file, partner, "user");
      if (match && !seenPartnerIds.has(match.partnerId)) {
        // CRITICAL: Check if user manually removed this file from this partner
        const isManuallyRemoved = partner.manualFileRemovals?.some(
          (r) => r.fileId === file.id
        );
        if (isManuallyRemoved) continue;

        seenPartnerIds.add(match.partnerId);
        results.push({
          partnerId: match.partnerId,
          partnerType: "user",
          confidence: match.confidence,
          source: match.source,
          partner,
        });
      }
    }

    // Then match against global partners
    for (const partner of globalPartners) {
      // Skip if user already has a local copy
      const hasLocalCopy = userPartners.some((up) => up.globalPartnerId === partner.id);
      if (hasLocalCopy) continue;

      const match = matchFileToPartner(file, partner, "global");
      if (match && !seenPartnerIds.has(match.partnerId)) {
        seenPartnerIds.add(match.partnerId);
        results.push({
          partnerId: match.partnerId,
          partnerType: "global",
          confidence: match.confidence,
          source: match.source,
          partner,
        });
      }
    }

    // Sort by confidence (highest first), user partners win ties
    return results.sort((a, b) => {
      if (b.confidence !== a.confidence) {
        return b.confidence - a.confidence;
      }
      if (a.partnerType === "user" && b.partnerType === "global") return -1;
      if (a.partnerType === "global" && b.partnerType === "user") return 1;
      return 0;
    }).slice(0, 3); // Top 3 suggestions
  }, [file, userPartners, globalPartners]);
}
