import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_LOCALE,
  localeFromAcceptLanguage,
  localeFromLanguages,
  withFallbackMessages,
} from "../lib/i18n/locale.js";

test("falls back to English (#168)", () => {
  assert.equal(DEFAULT_LOCALE, "en");
  assert.equal(localeFromAcceptLanguage(null), "en");
  assert.equal(localeFromAcceptLanguage("fr-FR,fr;q=0.9"), "en");
});

test("takes the first supported language the browser lists, by preference", () => {
  assert.equal(localeFromAcceptLanguage("de-AT,de;q=0.9,en;q=0.8"), "de");
  assert.equal(localeFromAcceptLanguage("fr-FR,fr;q=0.9,de;q=0.8,en;q=0.7"), "de");
  assert.equal(localeFromAcceptLanguage("en-GB,en;q=0.9,de;q=0.8"), "en");
  assert.equal(localeFromAcceptLanguage("en;q=0.5,de;q=0.9"), "de");
});

test("reads navigator.languages the same way", () => {
  assert.equal(localeFromLanguages(["de-AT", "en"]), "de");
  assert.equal(localeFromLanguages(["it-IT"]), "en");
  assert.equal(localeFromLanguages([]), "en");
});

test("a key missing in German shows the English text", () => {
  const en = { common: { save: "Save", cancel: "Cancel" }, only: { en: "English only" } };
  const de = { common: { save: "Speichern" } };
  assert.deepEqual(withFallbackMessages(de, en), {
    common: { save: "Speichern", cancel: "Cancel" },
    only: { en: "English only" },
  });
});
