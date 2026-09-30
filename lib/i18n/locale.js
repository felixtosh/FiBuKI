// UI language resolution (#168): German and English, English wherever the
// browser asks for anything else and wherever a German message is missing.
// Plain JS so the node test runner and next.config-time code can load it.

export const LOCALES = ["de", "en"];
export const DEFAULT_LOCALE = "en";

/** @param {unknown} value */
export function isLocale(value) {
  return typeof value === "string" && LOCALES.includes(value);
}

/** @param {string} tag e.g. "de-AT" */
function baseLanguage(tag) {
  return tag.trim().split("-")[0].toLowerCase();
}

/**
 * The first supported language in an Accept-Language header, by q-value.
 * @param {string | null | undefined} header
 */
export function localeFromAcceptLanguage(header) {
  if (!header) return DEFAULT_LOCALE;
  const ranked = header
    .split(",")
    .map((part, index) => {
      const [tag, ...params] = part.split(";");
      const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
      return { lang: baseLanguage(tag), q: q ? Number(q.slice(2)) : 1, index };
    })
    .filter((entry) => entry.lang && !Number.isNaN(entry.q))
    .sort((a, b) => b.q - a.q || a.index - b.index);
  return ranked.find((entry) => isLocale(entry.lang))?.lang ?? DEFAULT_LOCALE;
}

/**
 * The first supported language in the browser's preference list.
 * @param {readonly string[] | undefined} languages navigator.languages
 */
export function localeFromLanguages(languages) {
  const hit = (languages ?? []).map(baseLanguage).find((lang) => isLocale(lang));
  return hit ?? DEFAULT_LOCALE;
}

/**
 * `messages` with every key it lacks filled from `fallback`, recursively.
 * @param {Record<string, unknown>} messages
 * @param {Record<string, unknown>} fallback
 */
export function withFallbackMessages(messages, fallback) {
  /** @type {Record<string, unknown>} */
  const out = { ...fallback };
  for (const [key, value] of Object.entries(messages)) {
    const base = fallback[key];
    out[key] =
      value && typeof value === "object" && !Array.isArray(value) && base && typeof base === "object"
        ? withFallbackMessages(/** @type {Record<string, unknown>} */ (value), /** @type {Record<string, unknown>} */ (base))
        : value;
  }
  return out;
}
