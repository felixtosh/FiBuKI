/**
 * Toggle weekly digest email preference.
 */

import { FieldValue } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";

interface UpdateDigestPreferenceRequest {
  enabled: boolean;
}

interface UpdateDigestPreferenceResponse {
  success: boolean;
}

export const updateDigestPreferenceCallable = createCallable<
  UpdateDigestPreferenceRequest,
  UpdateDigestPreferenceResponse
>(
  { name: "updateDigestPreference" },
  async (ctx, request) => {
    if (typeof request.enabled !== "boolean") {
      throw new HttpsError("invalid-argument", "enabled must be a boolean");
    }

    const subRef = ctx.db.collection("subscriptions").doc(ctx.userId);
    const subDoc = await subRef.get();

    if (subDoc.exists) {
      await subRef.update({
        digestEnabled: request.enabled,
        updatedAt: FieldValue.serverTimestamp(),
      });
    } else {
      await subRef.set(
        {
          digestEnabled: request.enabled,
          updatedAt: FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    return { success: true };
  }
);
