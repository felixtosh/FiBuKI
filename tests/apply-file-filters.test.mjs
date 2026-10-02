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

// --- The deleted-files view (#268): deleted rows shown instead of hidden ---

test("applyFileFilters: deletedOnly shows only deleted files — the deleted-files view", () => {
  const files = [
    makeFile({ id: "live" }),
    makeFile({ id: "gone", deletedAt: ts(new Date()) }),
  ];
  const { rows } = applyFileFilters(files, { deletedOnly: true });
  assert.deepEqual(rows.map((f) => f.id), ["gone"]);
});

test("applyFileFilters: the page's other filters keep working on deleted rows", () => {
  const files = [
    makeFile({ id: "gone-acme", deletedAt: ts(new Date()), extractedPartner: "Acme" }),
    makeFile({ id: "gone-beta", deletedAt: ts(new Date()), extractedPartner: "Beta" }),
  ];
  const { rows } = applyFileFilters(files, { deletedOnly: true, search: "acme" });
  assert.deepEqual(rows.map((f) => f.id), ["gone-acme"]);
});

test("applyFileFilters: a purged skeleton never shows, in any view", () => {
  const files = [
    makeFile({ id: "live" }),
    makeFile({ id: "gone", deletedAt: ts(new Date()) }),
    { id: "purged", userId: "u", transactionIds: [], deletedAt: ts(new Date()), purgedAt: ts(new Date()) },
  ];
  assert.deepEqual(applyFileFilters(files, {}).rows.map((f) => f.id), ["live"]);
  assert.deepEqual(
    applyFileFilters(files, { deletedOnly: true }).rows.map((f) => f.id),
    ["gone"]
  );
  assert.deepEqual(
    applyFileFilters(files, { includeDeleted: true }).rows.map((f) => f.id).sort(),
    ["gone", "live"]
  );
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

test("applyFileFilters: search also matches the invoice number and the amount (#247)", () => {
  const files = [
    makeFile({ id: "a", extractedInvoiceNumber: "RE-2026-017", extractedAmount: 4299 }),
    makeFile({ id: "b", extractedInvoiceNumber: null, extractedAmount: 144200 }),
  ];
  assert.deepEqual(applyFileFilters(files, { search: "re-2026" }).rows.map((f) => f.id), ["a"]);
  assert.deepEqual(applyFileFilters(files, { search: "€42" }).rows.map((f) => f.id), ["a"]);
  assert.deepEqual(applyFileFilters(files, { search: "1.442,00" }).rows.map((f) => f.id), ["b"]);
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

test("applyFileFilters: documentTypes keeps only the selected Document Types (#250)", () => {
  const files = [
    makeFile({ id: "inv", documentType: "invoice" }),
    makeFile({ id: "rec", documentType: "receipt" }),
    makeFile({ id: "oth", documentType: "other", isNotInvoice: true }),
    makeFile({ id: "unk", documentType: "unknown" }),
  ];
  assert.deepEqual(
    applyFileFilters(files, { documentTypes: ["other"] }).rows.map((f) => f.id),
    ["oth"],
  );
  assert.deepEqual(
    applyFileFilters(files, { documentTypes: ["invoice", "receipt"] }).rows.map((f) => f.id),
    ["inv", "rec"],
  );
  assert.deepEqual(
    applyFileFilters(files, { documentTypes: ["invoice", "receipt", "unknown"] }).rows.map((f) => f.id),
    ["inv", "rec", "unk"],
  );
});

test("applyFileFilters: no documentTypes selection shows every type", () => {
  const files = [
    makeFile({ id: "inv", documentType: "invoice" }),
    makeFile({ id: "oth", documentType: "other" }),
  ];
  assert.deepEqual(applyFileFilters(files, {}).rows.map((f) => f.id), ["inv", "oth"]);
});

test("applyFileFilters: a File with no Document Type filters as unknown", () => {
  const files = [
    makeFile({ id: "legacy", documentType: undefined }),
    makeFile({ id: "inv", documentType: "invoice" }),
  ];
  assert.deepEqual(
    applyFileFilters(files, { documentTypes: ["unknown"] }).rows.map((f) => f.id),
    ["legacy"],
  );
  assert.deepEqual(
    applyFileFilters(files, { documentTypes: ["invoice"] }).rows.map((f) => f.id),
    ["inv"],
  );
});

test("applyFileFilters: an empty documentTypes selection hides every row", () => {
  const files = [makeFile({ id: "a", documentType: "invoice" })];
  assert.deepEqual(applyFileFilters(files, { documentTypes: [] }).rows, []);
});

test("applyFileFilters: documentTypes combines with the other filters", () => {
  const files = [
    makeFile({ id: "connected-invoice", documentType: "invoice", transactionIds: ["t1"] }),
    makeFile({ id: "connected-other", documentType: "other", transactionIds: ["t1"] }),
    makeFile({ id: "loose-invoice", documentType: "invoice", transactionIds: [] }),
  ];
  const { rows } = applyFileFilters(files, {
    documentTypes: ["invoice", "receipt", "unknown"],
    hasConnections: true,
  });
  assert.deepEqual(rows.map((f) => f.id), ["connected-invoice"]);
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

test("applyFileFilters: Type not-invoice keeps only not-invoices, income/expense drop them (#519)", () => {
  const files = [
    makeFile({ id: "in", invoiceDirection: "incoming" }),
    makeFile({ id: "in-not", invoiceDirection: "incoming", isNotInvoice: true }),
    makeFile({ id: "not", isNotInvoice: true }),
  ];
  assert.deepEqual(
    applyFileFilters(files, { amountType: "not-invoice" }).rows.map((f) => f.id),
    ["in-not", "not"],
  );
  assert.deepEqual(
    applyFileFilters(files, { amountType: "expense" }).rows.map((f) => f.id),
    ["in"],
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

test("applyFileFilters: invoiceCount is zero when only Document Type other is shown", () => {
  const files = [makeFile({ id: "a", isNotInvoice: true, documentType: "other" })];
  const { rows, invoiceCount } = applyFileFilters(files, { documentTypes: ["other"] });
  assert.equal(rows.length, 1);
  assert.equal(invoiceCount, 0);
});
