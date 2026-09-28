import test from "node:test";
import assert from "node:assert/strict";
import {
  fileDisplayName,
  describeFileNameCell,
} from "../lib/files/file-display-name.js";

function makeFile(overrides = {}) {
  return {
    fileName: "scan_0042.pdf",
    extractedInvoiceNumber: null,
    classificationComplete: true,
    extractionComplete: true,
    isNotInvoice: false,
    ...overrides,
  };
}

test("fileDisplayName: the invoice number wins when the File has one", () => {
  assert.equal(
    fileDisplayName(makeFile({ extractedInvoiceNumber: "RE-2026-017" })),
    "RE-2026-017",
  );
});

test("fileDisplayName: falls back to the file name when there is no invoice number", () => {
  for (const value of [undefined, null, "", "   "]) {
    assert.equal(
      fileDisplayName(makeFile({ extractedInvoiceNumber: value })),
      "scan_0042.pdf",
    );
  }
});

test("fileDisplayName: trims the invoice number it shows", () => {
  assert.equal(
    fileDisplayName(makeFile({ extractedInvoiceNumber: "  RE-1  " })),
    "RE-1",
  );
});

test("describeFileNameCell: invoice number shown, file name is the second line", () => {
  const cell = describeFileNameCell(makeFile({ extractedInvoiceNumber: "RE-1" }));
  assert.deepEqual(cell, {
    name: "RE-1",
    secondLine: { kind: "fileName", text: "scan_0042.pdf" },
  });
});

test("describeFileNameCell: file name shown, no second line when nothing is processing", () => {
  const cell = describeFileNameCell(makeFile());
  assert.deepEqual(cell, { name: "scan_0042.pdf", secondLine: null });
});

test("describeFileNameCell: 'Analyzing...' takes the second line over the file name", () => {
  const cell = describeFileNameCell(
    makeFile({ extractedInvoiceNumber: "RE-1", classificationComplete: false }),
  );
  assert.deepEqual(cell, {
    name: "RE-1",
    secondLine: { kind: "status", text: "Analyzing...", busy: true },
  });
});

test("describeFileNameCell: 'Parsing...' takes the second line over the file name", () => {
  const cell = describeFileNameCell(
    makeFile({ extractedInvoiceNumber: "RE-1", extractionComplete: false }),
  );
  assert.deepEqual(cell.secondLine, { kind: "status", text: "Parsing...", busy: true });
});

test("describeFileNameCell: 'Not an invoice' takes the second line over the file name", () => {
  const cell = describeFileNameCell(
    makeFile({ extractedInvoiceNumber: "RE-1", isNotInvoice: true }),
  );
  assert.deepEqual(cell.secondLine, { kind: "status", text: "Not an invoice", busy: false });
});

test("describeFileNameCell: a status still shows when the file name is already the name", () => {
  const cell = describeFileNameCell(makeFile({ classificationComplete: false }));
  assert.deepEqual(cell, {
    name: "scan_0042.pdf",
    secondLine: { kind: "status", text: "Analyzing...", busy: true },
  });
});
