/**
 * Update a source (bank account)
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { buildSourcePartnerData, mergeSourcePartnerData } from "./sourcePartnerUtils";

interface SourceUpdateData {
  name?: string;
  accountKind?: "checking" | "savings" | "creditCard" | "other";
  iban?: string | null;
  linkedSourceId?: string | null;
  cardLast4?: string | null;
  cardBrand?: string | null;
  currency?: string;
  fieldMappings?: {
    mappings: Record<string, string>;
    formats?: Record<string, string>;
    updatedAt: string;
  } | null;
  openingBalance?: number | null;
  openingBalanceDate?: string | null; // ISO string
  openingBalanceSource?: "csv_derived" | "api_fetched" | "manual" | null;
  latestBalance?: number | null;
  latestBalanceDate?: string | null; // ISO string
}

interface UpdateSourceRequest {
  sourceId: string;
  data: SourceUpdateData;
}

interface UpdateSourceResponse {
  success: boolean;
}

function normalizeIban(iban: string): string {
  return iban.replace(/\s/g, "").toUpperCase();
}

export const updateSourceCallable = createCallable<
  UpdateSourceRequest,
  UpdateSourceResponse
>(
  { name: "updateSource" },
  async (ctx, request) => {
    const { sourceId, data } = request;

    if (!sourceId) {
      throw new HttpsError("invalid-argument", "sourceId is required");
    }

    // Verify ownership
    const sourceRef = ctx.db.collection("sources").doc(sourceId);
    const sourceSnap = await sourceRef.get();

    if (!sourceSnap.exists) {
      throw new HttpsError("not-found", "Source not found");
    }

    if (sourceSnap.data()!.userId !== ctx.userId) {
      throw new HttpsError("permission-denied", "Access denied");
    }

    // Build update object
    const updates: Record<string, unknown> = {
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (data.name !== undefined) {
      updates.name = data.name.trim();
    }
    if (data.accountKind !== undefined) {
      updates.accountKind = data.accountKind;
    }
    if (data.iban !== undefined) {
      updates.iban = data.iban ? normalizeIban(data.iban) : null;
    }
    if (data.linkedSourceId !== undefined) {
      updates.linkedSourceId = data.linkedSourceId;
    }
    if (data.cardLast4 !== undefined) {
      updates.cardLast4 = data.cardLast4;
    }
    if (data.cardBrand !== undefined) {
      updates.cardBrand = data.cardBrand;
    }
    if (data.currency !== undefined) {
      updates.currency = data.currency;
    }
    if (data.fieldMappings !== undefined) {
      updates.fieldMappings = data.fieldMappings;
    }
    if (data.openingBalance !== undefined) {
      updates.openingBalance = data.openingBalance;
    }
    if (data.openingBalanceDate !== undefined) {
      updates.openingBalanceDate = data.openingBalanceDate
        ? Timestamp.fromDate(new Date(data.openingBalanceDate))
        : null;
    }
    if (data.openingBalanceSource !== undefined) {
      updates.openingBalanceSource = data.openingBalanceSource;
    }
    if (data.latestBalance !== undefined) {
      updates.latestBalance = data.latestBalance;
    }
    if (data.latestBalanceDate !== undefined) {
      updates.latestBalanceDate = data.latestBalanceDate
        ? Timestamp.fromDate(new Date(data.latestBalanceDate))
        : null;
    }

    await sourceRef.update(updates);

    // Sync source partner if partner-relevant fields changed
    const partnerRelevantFields = ["name", "iban", "cardLast4", "cardBrand"];
    const changedPartnerFields = partnerRelevantFields.filter((f) => f in updates);

    if (changedPartnerFields.length > 0) {
      const sourceData = sourceSnap.data()!;
      const sourcePartnerId = sourceData.sourcePartnerId;

      if (sourcePartnerId) {
        try {
          // Merge current source data with updates
          const mergedSource = {
            name: (updates.name as string) || sourceData.name || "",
            accountKind: sourceData.accountKind || "bank_account",
            iban: updates.iban !== undefined ? updates.iban : sourceData.iban,
            cardLast4: updates.cardLast4 !== undefined ? updates.cardLast4 : sourceData.cardLast4,
            cardBrand: updates.cardBrand !== undefined ? updates.cardBrand : sourceData.cardBrand,
          };

          const partnerData = buildSourcePartnerData(mergedSource);

          const partnerRef = ctx.db.collection("partners").doc(sourcePartnerId);
          const partnerSnap = await partnerRef.get();

          if (partnerSnap.exists && partnerSnap.data()?.userId === ctx.userId) {
            // Merge, never overwrite (#445): the Partner may carry aliases and
            // IBANs from before this edit (a pre-#380 merge, a replaced card),
            // and their historical Transactions must keep matching.
            const existingPartner = partnerSnap.data()!;
            const merged = mergeSourcePartnerData(
              {
                name: existingPartner.name as string | undefined,
                aliases: existingPartner.aliases as string[] | undefined,
                ibans: existingPartner.ibans as string[] | undefined,
              },
              partnerData,
              data.name !== undefined
            );
            await partnerRef.update({
              name: merged.name,
              aliases: merged.aliases,
              ibans: merged.ibans,
              updatedAt: FieldValue.serverTimestamp(),
            });
            console.log(`[updateSource] Synced source partner ${sourcePartnerId}`, {
              changedFields: changedPartnerFields,
            });
          }
        } catch (err) {
          console.error(`[updateSource] Failed to sync source partner:`, err);
        }
      }
    }

    console.log(`[updateSource] Updated source ${sourceId}`, {
      userId: ctx.userId,
      fields: Object.keys(updates),
    });

    return { success: true };
  }
);
