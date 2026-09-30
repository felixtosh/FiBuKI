export type Locale = "de" | "en";
export const LOCALES: readonly Locale[];
export const DEFAULT_LOCALE: Locale;
export function isLocale(value: unknown): value is Locale;
export function localeFromAcceptLanguage(header: string | null | undefined): Locale;
export function localeFromLanguages(languages: readonly string[] | undefined): Locale;
export function withFallbackMessages<T extends Record<string, unknown>>(
  messages: Record<string, unknown>,
  fallback: T
): T;
