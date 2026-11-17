/**
 * Create a new source (bank account)
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";
import { buildSourcePartnerData } from "./sourcePartnerUtils";
import { type AccountKind, refuseInvalidAccountKindFields } from "./accountKind";

interface SourceFormData {
  name: string;
  accountKind: AccountKind;
  iban?: string | null;
  linkedSourceId?: string | null;
  cardLast4?: string | null;
  cardBrand?: string | null;
  brokerName?: string | null;
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

/**
 * Internal implementation for creating a source.
 * Can be called directly from MCP handlers.
 */
export async function createSourceInternal(
  dbRef: FirebaseFirestore.Firestore,
  userId: string,
  data: SourceFormData,
  options?: { isAdmin?: boolean }
): Promise<CreateSourceResponse> {
  if (!data?.name?.trim()) {
    throw new HttpsError("invalid-argument", "Source name is required");
  }

  if (!data.currency) {
    throw new HttpsError("invalid-argument", "Currency is required");
  }

  refuseInvalidAccountKindFields(data);

  // Check investments addon for depot sources
  if (data.accountKind === "depot") {
    if (!options?.isAdmin) {
      const subSnap = await dbRef.collection("subscriptions").doc(userId).get();
      if (!subSnap.exists || !subSnap.data()?.addons?.investments?.active) {
        throw new HttpsError(
          "permission-denied",
          "Investments addon required for depot accounts. Activate it in Settings > Billing."
        );
      }
    }
  }

  const now = Timestamp.now();

  const newSource: Record<string, unknown> = {
    name: data.name.trim(),
    accountKind: data.accountKind || "bank_account",
    iban: data.iban ? normalizeIban(data.iban) : null,
    linkedSourceId: data.linkedSourceId || null,
    cardLast4: data.cardLast4 || null,
    cardBrand: data.cardBrand || null,
    currency: data.currency,
    type: data.type || "manual",
    isActive: true,
    userId,
    createdAt: now,
    updatedAt: now,
  };

  // Add broker name for depot sources
  if (data.accountKind === "depot" && data.brokerName) {
    newSource.brokerName = data.brokerName;
  }

  const docRef = await dbRef.collection("sources").add(newSource);
  const sourceId = docRef.id;

  // Auto-create source partner for pattern learning + reconciliation
  // Skip for depot sources — they don't participate in transaction matching
  if (data.accountKind === "depot") {
    console.log(`[createSource] Created depot source ${sourceId} (broker: ${data.brokerName || "unknown"})`, {
      userId,
      name: data.name,
    });
    return { success: true, sourceId };
  }

  try {
    const partnerData = buildSourcePartnerData({
      name: newSource.name as string,
      accountKind: newSource.accountKind as string,
      iban: newSource.iban as string | null | undefined,
      cardLast4: newSource.cardLast4 as string | null | undefined,
      cardBrand: newSource.cardBrand as string | null | undefined,
    });

    const newPartner: Record<string, unknown> = {
      userId,
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
      const categoriesSnap = await dbRef
        .collection("noReceiptCategories")
        .where("userId", "==", userId)
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

    const partnerRef = await dbRef.collection("partners").add(newPartner);

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
    userId,
    name: data.name,
    type: data.type,
  });

  return {
    success: true,
    sourceId,
  };
}

export const createSourceCallable = createCallable<
  CreateSourceRequest,
  CreateSourceResponse
>(
  { name: "createSource" },
  async (ctx, request) => {
    const isAdmin = ctx.request.auth?.token?.admin === true;
    return createSourceInternal(ctx.db, ctx.userId, request.data, { isAdmin });
  }
);
