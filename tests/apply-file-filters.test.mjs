import test from "node:test";
import assert from "node:assert/strict";
import { applyFileFilters } from "../lib/filters/apply-file-filters.js";

function ts(date) {
  return { toDate: () => date };
}

function makeFile(overrides = {}) {
  return {
    id: "f1",
    fileName: "invoice.pdf",
    extractedPartner: "Acme",
    transactionIds: [],
    extractionComplete: true,
    isNotInvoice: false,
    extractedDate: null,
    partnerId: undefined,
    invoiceDirection: undefined,
    deletedAt: null,
    ...overrides,
  };
}

test("applyFileFilters: excludes soft-deleted files by default", () => {
  const files = [makeFile({ id: "a" }), makeFile({ id: "b", deletedAt: ts(new Date()) })];
  const { rows } = applyFileFilters(files, {});
  assert.deepEqual(rows.map((f) => f.id), ["a"]);
});

test("applyFileFilters: includeDeleted keeps soft-deleted files", () => {
  const files = [makeFile({ id: "a" }), makeFile({ id: "b", deletedAt: ts(new Date()) })];
  const { rows } = applyFileFilters(files, { includeDeleted: true });
  assert.deepEqual(rows.map((f) => f.id).sort(), ["a", "b"]);
});

test("applyFileFilters: search matches fileName or extractedPartner, case-insensitive", () => {
  const files = [
    makeFile({ id: "a", fileName: "Receipt.pdf", extractedPartner: "Acme" }),
    makeFile({ id: "b", fileName: "other.pdf", extractedPartner: "Beta" }),
  ];
  assert.deepEqual(applyFileFilters(files, { search: "acme" }).rows.map((f) => f.id), ["a"]);
  assert.deepEqual(applyFileFilters(files, { search: "receipt" }).rows.map((f) => f.id), ["a"]);
  assert.deepEqual(applyFileFilters(files, { search: "nomatch" }).rows, []);
});

test("applyFileFilters: hasConnections true/false", () => {
  const files = [
    makeFile({ id: "a", transactionIds: ["t1"] }),
    makeFile({ id: "b", transactionIds: [] }),
  ];
  assert.deepEqual(
    applyFileFilters(files, { hasConnections: true }).rows.map((f) => f.id),
    ["a"],
  );
  assert.deepEqual(
    applyFileFilters(files, { hasConnections: false }).rows.map((f) => f.id),
    ["b"],
  );
});

test("applyFileFilters: extractionComplete filter", () => {
  const files = [
    makeFile({ id: "a", extractionComplete: true }),
    makeFile({ id: "b", extractionComplete: false }),
  ];
  assert.deepEqual(
    applyFileFilters(files, { extractionComplete: true }).rows.map((f) => f.id),
    ["a"],
  );
  assert.deepEqual(
    applyFileFilters(files, { extractionComplete: false }).rows.map((f) => f.id),
    ["b"],
  );
});

test("applyFileFilters: isNotInvoice filter shows only not-invoices when true, only invoices when false", () => {
  const files = [
    makeFile({ id: "a", isNotInvoice: true }),
    makeFile({ id: "b", isNotInvoice: false }),
  ];
  assert.deepEqual(
    applyFileFilters(files, { isNotInvoice: true }).rows.map((f) => f.id),
    ["a"],
  );
  assert.deepEqual(
    applyFileFilters(files, { isNotInvoice: false }).rows.map((f) => f.id),
    ["b"],
  );
  assert.deepEqual(
    applyFileFilters(files, {}).rows.map((f) => f.id).sort(),
    ["a", "b"],
  );
});

test("applyFileFilters: isNotInvoice=false hides not-invoice rows and the count follows", () => {
  const files = [
    makeFile({ id: "a", isNotInvoice: false }),
    makeFile({ id: "b", isNotInvoice: true }),
    makeFile({ id: "c" }),
    // A file uploaded before the flag existed has no isNotInvoice at all.
    makeFile({ id: "d", isNotInvoice: undefined }),
  ];
  const { rows, invoiceCount } = applyFileFilters(files, { isNotInvoice: false });
  assert.deepEqual(rows.map((f) => f.id).sort(), ["a", "c", "d"]);
  assert.equal(invoiceCount, 3);
});

test("applyFileFilters: isNotInvoice=false combines with the other filters", () => {
  const files = [
    makeFile({ id: "connected-invoice", transactionIds: ["t1"] }),
    makeFile({ id: "connected-not-invoice", transactionIds: ["t1"], isNotInvoice: true }),
    makeFile({ id: "loose-invoice", transactionIds: [] }),
  ];
  const { rows } = applyFileFilters(files, { isNotInvoice: false, hasConnections: true });
  assert.deepEqual(rows.map((f) => f.id), ["connected-invoice"]);
});

test("applyFileFilters: isNotInvoice=false can hide every row", () => {
  const files = [makeFile({ id: "a", isNotInvoice: true }), makeFile({ id: "b", isNotInvoice: true })];
  const { rows, invoiceCount } = applyFileFilters(files, { isNotInvoice: false });
  assert.deepEqual(rows, []);
  assert.equal(invoiceCount, 0);
});

test("applyFileFilters: extractedDateFrom/To range is inclusive of the end date", () => {
  const files = [
    makeFile({ id: "before", extractedDate: ts(new Date("2026-01-01")) }),
    makeFile({ id: "in-range", extractedDate: ts(new Date("2026-02-15")) }),
    makeFile({ id: "on-end", extractedDate: ts(new Date("2026-03-01")) }),
    makeFile({ id: "after", extractedDate: ts(new Date("2026-04-01")) }),
    makeFile({ id: "no-date", extractedDate: null }),
  ];
  const { rows } = applyFileFilters(files, {
    extractedDateFrom: new Date("2026-02-01"),
    extractedDateTo: new Date("2026-03-01"),
  });
  assert.deepEqual(rows.map((f) => f.id).sort(), ["in-range", "on-end"]);
});

test("applyFileFilters: partnerIds filter", () => {
  const files = [
    makeFile({ id: "a", partnerId: "p1" }),
    makeFile({ id: "b", partnerId: "p2" }),
    makeFile({ id: "c", partnerId: undefined }),
  ];
  const { rows } = applyFileFilters(files, { partnerIds: ["p1"] });
  assert.deepEqual(rows.map((f) => f.id), ["a"]);
});

test("applyFileFilters: hasPartner true keeps only files with a partner", () => {
  const files = [
    makeFile({ id: "a", partnerId: "p1" }),
    makeFile({ id: "b", partnerId: undefined }),
    makeFile({ id: "c", partnerId: "" }),
  ];
  const { rows } = applyFileFilters(files, { hasPartner: true });
  assert.deepEqual(rows.map((f) => f.id), ["a"]);
});

test("applyFileFilters: hasPartner false keeps only files without a partner", () => {
  const files = [
    makeFile({ id: "a", partnerId: "p1" }),
    makeFile({ id: "b", partnerId: undefined }),
    makeFile({ id: "c", partnerId: "" }),
  ];
  const { rows } = applyFileFilters(files, { hasPartner: false });
  assert.deepEqual(rows.map((f) => f.id).sort(), ["b", "c"]);
});

test("applyFileFilters: an unset hasPartner leaves both piles in place", () => {
  const files = [
    makeFile({ id: "a", partnerId: "p1" }),
    makeFile({ id: "b", partnerId: undefined }),
  ];
  const { rows } = applyFileFilters(files, {});
  assert.deepEqual(rows.map((f) => f.id).sort(), ["a", "b"]);
});

test("applyFileFilters: picked partnerIds win over hasPartner", () => {
  const files = [
    makeFile({ id: "a", partnerId: "p1" }),
    makeFile({ id: "b", partnerId: "p2" }),
    makeFile({ id: "c", partnerId: undefined }),
  ];
  // "no partner" would keep only c, but the named partner is the narrower ask.
  assert.deepEqual(
    applyFileFilters(files, { partnerIds: ["p1"], hasPartner: false }).rows.map((f) => f.id),
    ["a"],
  );
  assert.deepEqual(
    applyFileFilters(files, { partnerIds: ["p1"], hasPartner: true }).rows.map((f) => f.id),
    ["a"],
  );
  // An empty list is not a pick, so the state filter still applies.
  assert.deepEqual(
    applyFileFilters(files, { partnerIds: [], hasPartner: false }).rows.map((f) => f.id),
    ["c"],
  );
});

test("applyFileFilters: amountType income/expense maps to invoiceDirection", () => {
  const files = [
    makeFile({ id: "out", invoiceDirection: "outgoing" }),
    makeFile({ id: "in", invoiceDirection: "incoming" }),
    makeFile({ id: "none", invoiceDirection: undefined }),
  ];
  assert.deepEqual(
    applyFileFilters(files, { amountType: "income" }).rows.map((f) => f.id),
    ["out"],
  );
  assert.deepEqual(
    applyFileFilters(files, { amountType: "expense" }).rows.map((f) => f.id),
    ["in"],
  );
  assert.deepEqual(
    applyFileFilters(files, { amountType: "all" }).rows.map((f) => f.id).sort(),
    ["in", "none", "out"],
  );
});

test("applyFileFilters: invoiceCount excludes not-invoices with no filters applied", () => {
  const files = [
    makeFile({ id: "a", isNotInvoice: false }),
    makeFile({ id: "b", isNotInvoice: true }),
    makeFile({ id: "c", isNotInvoice: false }),
  ];
  const { rows, invoiceCount } = applyFileFilters(files, {});
  assert.equal(rows.length, 3);
  assert.equal(invoiceCount, 2);
});

test("applyFileFilters: invoiceCount excludes not-invoices regardless of other active filters", () => {
  const files = [
    makeFile({ id: "a", isNotInvoice: false, hasConnections: true, transactionIds: ["t1"] }),
    makeFile({ id: "b", isNotInvoice: true, transactionIds: ["t1"] }),
  ];
  const { rows, invoiceCount } = applyFileFilters(files, { hasConnections: true });
  assert.deepEqual(rows.map((f) => f.id).sort(), ["a", "b"]);
  assert.equal(invoiceCount, 1);
});

test("applyFileFilters: invoiceCount is zero when the isNotInvoice=true filter shows only not-invoices", () => {
  const files = [makeFile({ id: "a", isNotInvoice: true })];
  const { rows, invoiceCount } = applyFileFilters(files, { isNotInvoice: true });
  assert.equal(rows.length, 1);
  assert.equal(invoiceCount, 0);
});
