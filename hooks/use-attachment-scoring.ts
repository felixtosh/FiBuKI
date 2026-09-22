"use client";

import { useCallback } from "react";
import { useAuth } from "@/components/auth";

// ============================================================================
// Types
// ============================================================================

export interface AttachmentToScore {
  key: string;
  filename: string;
  mimeType: string;
  // Email context (for Gmail attachments)
  emailSubject?: string | null;
  emailFrom?: string | null;
  emailSnippet?: string | null;
  emailBodyText?: string | null;
  emailDate?: Date | null;
  integrationId?: string | null;
  // File extracted data (for local files)
  fileExtractedAmount?: number | null;
  fileExtractedDate?: Date | null;
  fileExtractedPartner?: string | null;
  filePartnerId?: string | null;
  // Email classification
  classification?: {
    hasPdfAttachment?: boolean;
    possibleMailInvoice?: boolean;
    possibleInvoiceLink?: boolean;
    confidence?: number;
  } | null;
}

export interface TransactionForScoring {
  /**
   * The Transaction being scored against. The server derives Coverage from it
   * (#239); nothing about the Remainder is computed on this side. Absent for a
   * Transaction with no id yet, which scores against the full amount.
   */
  id?: string | null;
  amount?: number | null;
  date?: Date | null;
  name?: string | null;
  reference?: string | null;
  partner?: string | null;
  partnerId?: string | null;
}

export interface PartnerForScoring {
  name?: string | null;
  emailDomains?: string[] | null;
  fileSourcePatterns?: Array<{
    sourceType: string;
    integrationId?: string;
  }> | null;
}

export interface ScoredAttachment {
  key: string;
  score: number;
  label: "Strong" | "Likely" | null;
  reasons: string[];
  /** Scored against the Transaction's Remainder — suggestion only (#239). */
  scoredAgainstRemainder?: boolean;
}

/**
 * Hook for scoring attachments against a transaction
 * Uses the unified scoring API route (/api/matching/score-files)
 */
export function useAttachmentScoring() {
  const { user } = useAuth();

  const scoreAttachments = useCallback(
    async (
      attachments: AttachmentToScore[],
      transaction: TransactionForScoring,
      partner?: PartnerForScoring | null
    ): Promise<ScoredAttachment[]> => {
      if (attachments.length === 0) {
        return [];
      }

      try {
        // Get auth token for the API call
        const token = user ? await user.getIdToken() : null;

        const response = await fetch("/api/matching/score-files", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify({
            attachments: attachments.map((att) => ({
              key: att.key,
              filename: att.filename,
              mimeType: att.mimeType,
              emailSubject: att.emailSubject,
              emailFrom: att.emailFrom,
              emailSnippet: att.emailSnippet,
              emailBodyText: att.emailBodyText,
              emailDate: att.emailDate?.toISOString() || null,
              integrationId: att.integrationId,
              fileExtractedAmount: att.fileExtractedAmount,
              fileExtractedDate: att.fileExtractedDate?.toISOString() || null,
              fileExtractedPartner: att.fileExtractedPartner,
              filePartnerId: att.filePartnerId,
              classification: att.classification,
            })),
            transaction: {
              id: transaction.id,
              amount: transaction.amount,
              date: transaction.date?.toISOString() || null,
              name: transaction.name,
              reference: transaction.reference,
              partner: transaction.partner,
              partnerId: transaction.partnerId,
            },
            partner: partner
              ? {
                  name: partner.name,
                  emailDomains: partner.emailDomains,
                  fileSourcePatterns: partner.fileSourcePatterns,
                }
              : null,
          }),
        });

        if (!response.ok) {
          throw new Error(`API error: ${response.status}`);
        }

        const result = await response.json();
        return result.scores;
      } catch (error) {
        console.error("[useAttachmentScoring] Error scoring attachments:", error);
        // Return empty scores on error (don't break the UI)
        return attachments.map((att) => ({
          key: att.key,
          score: 0,
          label: null,
          reasons: [],
        }));
      }
    },
    [user]
  );

  return { scoreAttachments };
}
