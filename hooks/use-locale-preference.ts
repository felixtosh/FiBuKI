"use client";

import { useCallback, useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { callFunction } from "@/lib/firebase/callable";
import { useAuth } from "@/components/auth";
import { isLocale, type Locale } from "@/lib/i18n/locale";

/** The cookie i18n/request.ts reads the UI language from. */
export function writeLocaleCookie(locale: Locale): void {
  document.cookie = `locale=${locale};path=/;max-age=31536000;samesite=lax`;
}

export function readLocaleCookie(): string | null {
  const match = document.cookie.match(/(?:^|;\s*)locale=([^;]+)/);
  return match ? match[1] : null;
}

/**
 * The signed-in user's saved UI language (#168), from
 * users/{uid}/settings/preferences. `undefined` while loading, `null` when
 * the user has never had one recorded.
 */
export function useLocalePreference() {
  const { user } = useAuth();
  const [locale, setLocaleState] = useState<Locale | null | undefined>(undefined);

  useEffect(() => {
    if (!user) return;
    return onSnapshot(doc(db, "users", user.uid, "settings", "preferences"), (snap) => {
      const value = snap.data()?.locale;
      setLocaleState(isLocale(value) ? value : null);
    });
  }, [user]);

  const saveLocale = useCallback(async (next: Locale, source: "browser" | "user" = "user") => {
    await callFunction("updateUserLocale", { locale: next, source });
    writeLocaleCookie(next);
  }, []);

  return { locale, saveLocale };
}
