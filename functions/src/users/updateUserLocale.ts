/**
 * Set the signed-in user's UI language (#168).
 *
 * Stored at users/{uid}/settings/preferences. LocaleSync writes the browser's
 * language here on a user's first session (source "browser"); the General
 * Settings switch writes the user's own choice (source "user").
 */

import { FieldValue } from "firebase-admin/firestore";
import { createCallable, HttpsError } from "../utils/createCallable";

const LOCALES = ["de", "en"] as const;
type Locale = (typeof LOCALES)[number];

interface UpdateUserLocaleRequest {
  locale: Locale;
  source?: "browser" | "user";
}

interface UpdateUserLocaleResponse {
  success: boolean;
  locale: Locale;
}

export const updateUserLocaleCallable = createCallable<
  UpdateUserLocaleRequest,
  UpdateUserLocaleResponse
>({ name: "updateUserLocale" }, async (ctx, request) => {
  const locale = request?.locale;
  if (!LOCALES.includes(locale)) {
    throw new HttpsError("invalid-argument", `locale must be one of: ${LOCALES.join(", ")}`);
  }

  await ctx.db
    .collection("users")
    .doc(ctx.userId)
    .collection("settings")
    .doc("preferences")
    .set(
      {
        locale,
        localeSource: request.source === "browser" ? "browser" : "user",
        updatedAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

  return { success: true, locale };
});
