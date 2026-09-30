"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { localeFromLanguages } from "@/lib/i18n/locale";
import { readLocaleCookie, useLocalePreference, writeLocaleCookie } from "@/hooks/use-locale-preference";

/**
 * Keeps the UI language equal to the signed-in user's saved choice (#168).
 *
 * A user with none recorded yet (a new signup, or an account from before
 * #168) gets the browser's language, English if it is neither German nor
 * English, saved once. After that the saved choice wins on every device: when
 * the cookie disagrees it is corrected and the page re-rendered.
 */
export function LocaleSync() {
  const router = useRouter();
  const { locale, saveLocale } = useLocalePreference();
  const recorded = useRef(false);

  useEffect(() => {
    if (locale === undefined) return;

    if (locale === null) {
      if (recorded.current) return;
      recorded.current = true;
      const detected = localeFromLanguages(navigator.languages);
      const shown = readLocaleCookie();
      void saveLocale(detected, "browser").then(() => {
        if (shown !== detected) router.refresh();
      });
      return;
    }

    if (readLocaleCookie() !== locale) {
      writeLocaleCookie(locale);
      router.refresh();
    }
  }, [locale, saveLocale, router]);

  return null;
}
