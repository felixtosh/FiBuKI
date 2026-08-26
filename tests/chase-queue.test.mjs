import test from "node:test";
import assert from "node:assert/strict";
import { buildChaseQueue, countChaseQueue } from "../lib/documents/chase-queue.js";

function ts(date) {
  return { toDate: () => date };
}

function tx(overrides = {}) {
  return {
    id: "t1",
    date: ts(new Date("2026-03-01T00:00:00Z")),
    amount: -12_000,
    currency: "EUR",
    name: "AMAZON EU SARL",
    partner: "Amazon",
    partnerId: null,
    fileIds: ["f1"],
    documentationState: "receipt-only",
    ...overrides,
  };
}

function file(overrides = {}) {
  return {
    id: "f1",
    fileName: "zahlungsbestaetigung.pdf",
    documentType: "receipt",
    documentTypeBasis: { reason: "no-vat-no-invoice-identity" },
    documentTypeMissingElements: ["steuersatz", "supplier-vat-id"],
    ...overrides,
  };
}

test("only receipt-only transactions are in the queue", () => {
  const transactions = [
    tx({ id: "chase", documentationState: "receipt-only" }),
    tx({ id: "invoiced", documentationState: "invoice" }),
    tx({ id: "category", documentationState: "no-receipt-category" }),
    tx({ id: "empty", documentationState: "undocumented" }),
    tx({ id: "unclassified", documentationState: "unknown" }),
  ];
  const { rows } = buildChaseQueue(transactions, [file()]);
  assert.deepEqual(rows.map((r) => r.id), ["chase"]);
});

test("a transaction that has never been checked is not work — an absent state is not a member", () => {
  // Every row written before #104 carries no state at all. Chasing those
  // would fill the queue with defects nobody has established exist.
  const transactions = [tx({ id: "legacy", documentationState: undefined })];
  const { rows, totalCount } = buildChaseQueue(transactions, [file()]);
  assert.equal(rows.length, 0);
  assert.equal(totalCount, 0);
});

test("a transaction holding both a receipt and an invoice is not chase work", () => {
  // The extra receipt must never downgrade a good line: the backend derives
  // `invoice` for it, and the queue has nothing to ask that supplier for.
  const transactions = [
    tx({ id: "both", fileIds: ["f1", "f2"], documentationState: "invoice" }),
  ];
  const files = [
    file({ id: "f1", documentType: "receipt" }),
    file({
      id: "f2",
      fileName: "rechnung.pdf",
      documentType: "invoice",
      documentTypeMissingElements: [],
    }),
  ];
  assert.deepEqual(buildChaseQueue(transactions, files).rows, []);
  assert.equal(countChaseQueue(transactions), 0);
});

test("a row carries the vendor, the amount, the date and the missing § 11 elements", () => {
  const { rows } = buildChaseQueue([tx()], [file()]);
  const [row] = rows;
  assert.equal(row.vendor, "Amazon");
  assert.equal(row.amount, -12_000);
  assert.equal(row.currency, "EUR");
  assert.equal(row.date.toISOString(), "2026-03-01T00:00:00.000Z");
  assert.deepEqual(row.missingElements, ["steuersatz", "supplier-vat-id"]);
  assert.deepEqual(row.documents.map((d) => d.fileName), ["zahlungsbestaetigung.pdf"]);
  assert.equal(row.documents[0].documentType, "receipt");
  assert.equal(row.documents[0].basisReason, "no-vat-no-invoice-identity");
});

test("the vendor falls back to the bank description when no counterparty was parsed", () => {
  const { rows } = buildChaseQueue([tx({ partner: null })], [file()]);
  assert.equal(rows[0].vendor, "AMAZON EU SARL");
});

test("missing elements are unioned across the attached documents, deduplicated", () => {
  const transactions = [tx({ fileIds: ["f1", "f2"] })];
  const files = [
    file({ id: "f1", documentTypeMissingElements: ["steuersatz", "recipient"] }),
    file({ id: "f2", documentTypeMissingElements: ["recipient", "invoice-number"] }),
  ];
  const { rows } = buildChaseQueue(transactions, files);
  assert.deepEqual(rows[0].missingElements, ["steuersatz", "recipient", "invoice-number"]);
});

test("a file id with no record behind it is dropped, not rendered blank", () => {
  const { rows } = buildChaseQueue([tx({ fileIds: ["f1", "gone"] })], [file()]);
  assert.deepEqual(rows[0].documents.map((d) => d.fileId), ["f1"]);
});

test("a document carrying no missing-element list contributes nothing rather than crashing", () => {
  const files = [file({ documentTypeMissingElements: undefined })];
  const { rows } = buildChaseQueue([tx()], files);
  assert.deepEqual(rows[0].missingElements, []);
  assert.equal(rows[0].documents[0].basisReason, "no-vat-no-invoice-identity");
});

test("the default order is the largest deduction first, sign ignored", () => {
  const transactions = [
    tx({ id: "small", amount: -400 }),
    tx({ id: "large", amount: -90_000 }),
    // An income line documented by a receipt only is still a gap, and its
    // sign says nothing about how much is at stake.
    tx({ id: "income", amount: 50_000 }),
  ];
  const { rows } = buildChaseQueue(transactions, [file()]);
  assert.deepEqual(rows.map((r) => r.id), ["large", "income", "small"]);
});

test("sorting by date puts the newest first", () => {
  const transactions = [
    tx({ id: "old", date: ts(new Date("2026-01-05T00:00:00Z")), amount: -90_000 }),
    tx({ id: "new", date: ts(new Date("2026-06-05T00:00:00Z")), amount: -400 }),
  ];
  const { rows } = buildChaseQueue(transactions, [file()], { sort: "date" });
  assert.deepEqual(rows.map((r) => r.id), ["new", "old"]);
});

test("equal amounts on the same day keep a stable order across reloads", () => {
  const same = ts(new Date("2026-02-02T00:00:00Z"));
  const transactions = [
    tx({ id: "b", date: same, amount: -1_000 }),
    tx({ id: "a", date: same, amount: -1_000 }),
  ];
  assert.deepEqual(
    buildChaseQueue(transactions, [file()]).rows.map((r) => r.id),
    ["a", "b"],
  );
  assert.deepEqual(
    buildChaseQueue([...transactions].reverse(), [file()]).rows.map((r) => r.id),
    ["a", "b"],
  );
});

test("minAmount filters on the absolute amount, the same way the agent tool does", () => {
  const transactions = [
    tx({ id: "under", amount: -3_999 }),
    tx({ id: "on", amount: -4_000 }),
    tx({ id: "income", amount: 9_000 }),
  ];
  const { rows } = buildChaseQueue(transactions, [file()], { minAmount: 4_000 });
  assert.deepEqual(rows.map((r) => r.id), ["income", "on"]);
});

test("totalCount reports the queue before the amount filter, so a threshold cannot hide work silently", () => {
  const transactions = [
    tx({ id: "under", amount: -100 }),
    tx({ id: "over", amount: -100_000 }),
  ];
  const { rows, totalCount, totalAmount } = buildChaseQueue(
    transactions,
    [file()],
    { minAmount: 50_000 },
  );
  assert.equal(rows.length, 1);
  assert.equal(totalCount, 2);
  assert.equal(totalAmount, 100_000);
});

test("a mixed-currency queue reports both currencies, so no caller prints a made-up total", () => {
  const transactions = [
    tx({ id: "eur", amount: -10_000, currency: "EUR" }),
    tx({ id: "usd", amount: -20_000, currency: "USD" }),
  ];
  const { currencies } = buildChaseQueue(transactions, [file()]);
  assert.deepEqual(currencies, ["EUR", "USD"]);

  const single = buildChaseQueue([tx({ currency: "CHF" })], [file()]);
  assert.deepEqual(single.currencies, ["CHF"]);
});

test("dates arrive in whichever shape the record was written in", () => {
  const shapes = [
    ts(new Date("2026-04-01T00:00:00Z")),
    new Date("2026-04-01T00:00:00Z"),
    "2026-04-01T00:00:00Z",
    Date.parse("2026-04-01T00:00:00Z"),
  ];
  for (const date of shapes) {
    const { rows } = buildChaseQueue([tx({ date })], [file()]);
    assert.equal(rows[0].date.toISOString(), "2026-04-01T00:00:00.000Z");
  }
});

test("an unreadable date leaves the row in the queue with no date rather than dropping it", () => {
  for (const date of [null, undefined, "not a date", {}]) {
    const { rows } = buildChaseQueue([tx({ date })], [file()]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].date, null);
  }
});

test("countChaseQueue counts without building rows, and survives an empty account", () => {
  assert.equal(countChaseQueue([tx(), tx({ documentationState: "invoice" })]), 1);
  assert.equal(countChaseQueue([]), 0);
  assert.equal(countChaseQueue(undefined), 0);
});

test("a corpus where nothing has been classified yet yields an empty queue, not an error", () => {
  // The state the account is in until the backfill runs.
  const corpus = Array.from({ length: 40 }, (_, i) =>
    tx({ id: `t${i}`, documentationState: undefined, fileIds: [] }),
  );
  const { rows, totalCount, totalAmount, currencies } = buildChaseQueue(corpus, []);
  assert.deepEqual(rows, []);
  assert.equal(totalCount, 0);
  assert.equal(totalAmount, 0);
  assert.deepEqual(currencies, []);
});
