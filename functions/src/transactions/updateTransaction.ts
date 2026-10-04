/**
 * Update a single transaction: what a foreign or 0% line is, for the UVA
 */

import { FieldValue } from "firebase-admin/firestore";
import { SALE_SUPPLY_KINDS, type SaleSupplyKind } from "../uva/types";
import { createCallable, HttpsError } from "../utils/createCallable";
import { assertWritableFields, WRITABLE_FIELDS } from "./writableFields";

interface UpdateTransactionRequest {
  /** Transaction ID to update */
  id: string;
  /**
   * Fields to update: the Reports page's answers to the UVA review (#621).
   * Partners, no-receipt categories and File Connections have their own
   * callables.
   */
  data: {
    /** Goods/service answer to the foreign-regime review (#214); null clears. */
    foreignSupplyKind?: "goods" | "service" | null;
    /** What a 0% sale is (#565); null clears back to the Invoice or detection. */
    saleSupplyKind?: SaleSupplyKind | null;
  };
}

interface UpdateTransactionResponse {
  success: boolean;
}

export const updateTransactionCallable = createCallable<
  UpdateTransactionRequest,
  UpdateTransactionResponse
>(
  { name: "updateTransaction" },
  async (ctx, request) => {
    const { id, data } = request;

    if (!id) {
      throw new HttpsError("invalid-argument", "Transaction ID is required");
    }

    assertWritableFields("updateTransaction", data, WRITABLE_FIELDS);

    if (
      data.foreignSupplyKind !== undefined &&
      data.foreignSupplyKind !== null &&
      data.foreignSupplyKind !== "goods" &&
      data.foreignSupplyKind !== "service"
    ) {
      throw new HttpsError(
        "invalid-argument",
        'foreignSupplyKind must be "goods", "service", or null to clear'
      );
    }

    if (
      data.saleSupplyKind !== undefined &&
      data.saleSupplyKind !== null &&
      !SALE_SUPPLY_KINDS.includes(data.saleSupplyKind)
    ) {
      throw new HttpsError(
        "invalid-argument",
        `saleSupplyKind must be one of ${SALE_SUPPLY_KINDS.join(", ")}, or null to clear`
      );
    }

    // Verify ownership
    const transactionRef = ctx.db.collection("transactions").doc(id);
    const transactionSnap = await transactionRef.get();

    if (!transactionSnap.exists) {
      throw new HttpsError("not-found", "Transaction not found");
    }

    const transactionData = transactionSnap.data();
    if (transactionData?.userId !== ctx.userId) {
      throw new HttpsError("permission-denied", "Access denied");
    }

    // Build update object, filtering out undefined values
    const updateData: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      if (value !== undefined) {
        updateData[key] = value;
      }
    }

    // Always update timestamp
    updateData.updatedAt = FieldValue.serverTimestamp();

    await transactionRef.update(updateData);

    console.log(`[updateTransaction] Updated transaction ${id}`, {
      userId: ctx.userId,
      fields: Object.keys(updateData),
    });

    return { success: true };
  }
);
