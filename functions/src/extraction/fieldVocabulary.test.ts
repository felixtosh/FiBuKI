/**
 * The UI names every extracted field and payment method from the translation
 * files by key (#540). A key without an English and a German name renders
 * untranslated, so every key the vocabulary holds must have both.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ADDITIONAL_FIELD_KEYS, PAYMENT_METHODS } from "./fieldVocabulary";

const REPO = path.resolve(__dirname, "../../..");

describe("extraction field vocabulary", () => {
  for (const locale of ["en", "de"]) {
    it(`every key and payment method has a ${locale} name`, () => {
      const messages = JSON.parse(readFileSync(path.join(REPO, `messages/${locale}.json`), "utf8"));
      const extracted = messages.files?.extracted ?? {};
      for (const key of ADDITIONAL_FIELD_KEYS) {
        expect(extracted.fields?.[key], `files.extracted.fields.${key}`).toBeTruthy();
      }
      for (const method of PAYMENT_METHODS) {
        expect(extracted.paymentMethods?.[method], `files.extracted.paymentMethods.${method}`).toBeTruthy();
      }
    });
  }
});
