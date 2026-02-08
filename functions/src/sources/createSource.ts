/**
 * Create a new source (bank account)
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { buildSourcePartnerData } from "./sourcePartnerUtils";

interface SourceFormData {
  name: string;
  accountKind: "bank_account" | "credit_card";
  iban?: string | null;
  linkedSourceId?: string | null;
  cardLast4?: string | null;
  cardBrand?: string | null;
  currency: string;
  type: "manual" | "api";
}

interface CreateSourceRequest {
  data: SourceFormData;
}

interface CreateSourceResponse {
  success: boolean;
  sourceId: string;
}

/**
 * Normalize IBAN by removing spaces and converting to uppercase
 */
function normalizeIban(iban: string): string {
  return iban.replace(/\s/g, "").toUpperCase();
}

export const createSourceCallable = createCallable<
  CreateSourceRequest,
  CreateSourceResponse
>(
  { name: "createSource" },
  async (ctx, request) => {
    const { data } = request;

    if (!data?.name?.trim()) {
      throw new HttpsError("invalid-argument", "Source name is required");
    }

    if (!data.currency) {
      throw new HttpsError("invalid-argument", "Currency is required");
    }

    const now = Timestamp.now();

    const newSource = {
      name: data.name.trim(),
      accountKind: data.accountKind || "checking",
      iban: data.iban ? normalizeIban(data.iban) : null,
      linkedSourceId: data.linkedSourceId || null,
      cardLast4: data.cardLast4 || null,
      cardBrand: data.cardBrand || null,
      currency: data.currency,
      type: data.type || "manual",
      isActive: true,
      userId: ctx.userId,
      createdAt: now,
      updatedAt: now,
    };

    const docRef = await ctx.db.collection("sources").add(newSource);
    const sourceId = docRef.id;

    // Auto-create source partner for pattern learning + reconciliation
    try {
      const partnerData = buildSourcePartnerData({
        name: newSource.name,
        accountKind: newSource.accountKind,
        iban: newSource.iban,
        cardLast4: newSource.cardLast4,
        cardBrand: newSource.cardBrand,
      });

      const newPartner: Record<string, unknown> = {
        userId: ctx.userId,
        name: partnerData.name,
        aliases: partnerData.aliases,
        address: null,
        country: null,
        vatId: null,
        ibans: partnerData.ibans,
        website: null,
        notes: null,
        defaultCategoryId: null,
        identitySourceField: `source:${sourceId}`,
        isActive: true,
        createdAt: now,
        updatedAt: now,
        createdBy: "source_sync",
      };

      // If credit card with a linked bank, add categoryMatchRule for internal-transfers
      if (newSource.accountKind === "credit_card" && newSource.linkedSourceId) {
        // Find the internal-transfers category for this user
        const categoriesSnap = await ctx.db
          .collection("noReceiptCategories")
          .where("userId", "==", ctx.userId)
          .where("templateId", "==", "internal-transfers")
          .where("isActive", "==", true)
          .limit(1)
          .get();

        if (!categoriesSnap.empty) {
          const categoryDoc = categoriesSnap.docs[0];
          newPartner.categoryMatchRules = [{
            categoryId: categoryDoc.id,
            templateId: "internal-transfers",
            confidence: 95,
            source: "source_sync",
          }];
        }
      }

      const partnerRef = await ctx.db.collection("partners").add(newPartner);

      // Write sourcePartnerId back to the source
      await docRef.update({
        sourcePartnerId: partnerRef.id,
        updatedAt: FieldValue.serverTimestamp(),
      });

      console.log(`[createSource] Created source partner ${partnerRef.id} for source ${sourceId}`, {
        aliases: partnerData.aliases.length,
      });
    } catch (err) {
      console.error(`[createSource] Failed to create source partner:`, err);
      // Non-fatal — source was still created successfully
    }

    console.log(`[createSource] Created source ${sourceId}`, {
      userId: ctx.userId,
      name: data.name,
      type: data.type,
    });

    return {
      success: true,
      sourceId,
    };
  }
);
