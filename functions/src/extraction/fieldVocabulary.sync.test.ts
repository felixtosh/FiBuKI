/**
 * The field vocabulary exists twice (#540) and neither copy can import the
 * other: functions/tsconfig.json pins `rootDir: "src"`. A key the backend
 * extracts and the frontend does not know would render untranslated; a key
 * the editor offers and the backend refuses would fail every save. So this
 * reads both files as TEXT and compares, like utils/models.sync.test.ts, and
 * checks every key and payment method has an English and a German name.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { ADDITIONAL_FIELD_KEYS, PAYMENT_METHODS } from "./fieldVocabulary";

const REPO = path.resolve(__dirname, "../../..");

function constList(file: string, name: string): string[] {
  const src = readFileSync(path.join(REPO, file), "utf8");
  const match = new RegExp(`export const ${name} = \\[([^\\]]*)\\]`).exec(src);
  if (!match) throw new Error(`${name} not found in ${file}`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("extraction field vocabulary sync", () => {
  it("frontend and backend list the same keys in the same order", () => {
    expect(constList("types/extraction-fields.ts", "ADDITIONAL_FIELD_KEYS")).toEqual([...ADDITIONAL_FIELD_KEYS]);
    expect(constList("types/extraction-fields.ts", "PAYMENT_METHODS")).toEqual([...PAYMENT_METHODS]);
  });

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
