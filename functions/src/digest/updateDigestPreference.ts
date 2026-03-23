/**
 * Unified email preference callable.
 * Supports toggling digest and budget warning emails.
 * Also exports legacy `updateDigestPreferenceCallable` for backward compat during deploy window.
 */

import { FieldValue } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";

// ---------- Unified callable ----------

type EmailPreference = "digest" | "budgetWarnings";

const PREFERENCE_FIELD: Record<EmailPreference, string> = {
  digest: "digestEnabled",
  budgetWarnings: "budgetWarningsEnabled",
};

interface UpdateEmailPreferenceRequest {
  preference: EmailPreference;
  enabled: boolean;
}

interface UpdateEmailPreferenceResponse {
  success: boolean;
}

export const updateEmailPreferenceCallable = createCallable<
  UpdateEmailPreferenceRequest,
  UpdateEmailPreferenceResponse
>(
  { name: "updateEmailPreference" },
  async (ctx, request) => {
    const { preference, enabled } = request;

    if (!PREFERENCE_FIELD[preference]) {
      throw new HttpsError(
        "invalid-argument",
        `preference must be one of: ${Object.keys(PREFERENCE_FIELD).join(", ")}`
      );
    }
    if (typeof enabled !== "boolean") {
      throw new HttpsError("invalid-argument", "enabled must be a boolean");
    }

    const field = PREFERENCE_FIELD[preference];
    const subRef = ctx.db.collection("subscriptions").doc(ctx.userId);

    await subRef.set(
      {
        [field]: enabled,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return { success: true };
  }
);

// ---------- Legacy alias (backward compat) ----------

interface LegacyRequest {
  enabled: boolean;
}

interface LegacyResponse {
  success: boolean;
}

export const updateDigestPreferenceCallable = createCallable<
  LegacyRequest,
  LegacyResponse
>(
  { name: "updateDigestPreference" },
  async (ctx, request) => {
    if (typeof request.enabled !== "boolean") {
      throw new HttpsError("invalid-argument", "enabled must be a boolean");
    }

    const subRef = ctx.db.collection("subscriptions").doc(ctx.userId);

    await subRef.set(
      {
        digestEnabled: request.enabled,
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return { success: true };
  }
);
