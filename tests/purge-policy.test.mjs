// The retention warning the Purge confirmation carries (#268).
//
// Purge is allowed with a warning instead of a refusal: BAO § 132 retention is
// the taxpayer's duty, so FiBuKI informs and the user decides. A File warns
// when it was ever attached to a Transaction, or is classified invoice/receipt
// and dated within the 7-year window. Junk purges without ceremony.

import test from "node:test";
import assert from "node:assert/strict";
import { isRetentionRelevant } from "../lib/files/purge-policy.js";

const NOW = new Date("2026-09-27T12:00:00Z");
const ts = (iso) => ({ toDate: () => new Date(iso) });

test("a File attached to a Transaction warns, whatever its type", () => {
  assert.equal(
    isRetentionRelevant({ transactionIds: ["tx-1"], documentType: "other" }, NOW),
    true
  );
});

test("a File that was attached when it was deleted warns too", () => {
  assert.equal(
    isRetentionRelevant(
      { transactionIds: [], hadTransactionConnections: true, documentType: "other" },
      NOW
    ),
    true
  );
});

test("an invoice or receipt dated within 7 years warns", () => {
  for (const documentType of ["invoice", "receipt"]) {
    assert.equal(
      isRetentionRelevant(
        { transactionIds: [], documentType, extractedDate: ts("2023-05-01") },
        NOW
      ),
      true
    );
  }
});

test("an invoice dated more than 7 years ago does not warn", () => {
  assert.equal(
    isRetentionRelevant(
      { transactionIds: [], documentType: "invoice", extractedDate: ts("2018-01-01") },
      NOW
    ),
    false
  );
});

test("an undated invoice warns — the window cannot be shown to have passed", () => {
  assert.equal(
    isRetentionRelevant({ transactionIds: [], documentType: "invoice" }, NOW),
    true
  );
});

test("junk does not warn: never attached, not an invoice or receipt", () => {
  for (const documentType of ["other", "unknown", undefined]) {
    assert.equal(
      isRetentionRelevant(
        { transactionIds: [], documentType, extractedDate: ts("2026-01-01") },
        NOW
      ),
      false
    );
  }
});

test("accepts a plain Date for the document date", () => {
  assert.equal(
    isRetentionRelevant(
      { transactionIds: [], documentType: "receipt", extractedDate: new Date("2025-02-02") },
      NOW
    ),
    true
  );
});
