import { getRequestConfig } from "next-intl/server";
import { cookies, headers } from "next/headers";
import {
  DEFAULT_LOCALE,
  LOCALES,
  isLocale,
  localeFromAcceptLanguage,
  withFallbackMessages,
  type Locale,
} from "@/lib/i18n/locale";

export const locales = LOCALES;
export type { Locale };
export const defaultLocale: Locale = DEFAULT_LOCALE;

/**
 * The UI language (#168): the `locale` cookie, which LocaleSync keeps equal to
 * the signed-in user's saved choice, else the browser's first supported
 * language, else English. A German message that is missing shows in English.
 */
export default getRequestConfig(async () => {
  const cookieLocale = (await cookies()).get("locale")?.value;
  const locale: Locale = isLocale(cookieLocale)
    ? cookieLocale
    : localeFromAcceptLanguage((await headers()).get("accept-language"));

  const english = (await import("../messages/en.json")).default;
  const messages =
    locale === "en"
      ? english
      : withFallbackMessages((await import(`../messages/${locale}.json`)).default, english);

  return { locale, messages };
});
