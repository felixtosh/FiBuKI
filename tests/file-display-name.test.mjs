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

test("describeFileNameCell: 'analyzing' takes the second line over the file name", () => {
  const cell = describeFileNameCell(
    makeFile({
      extractedInvoiceNumber: "RE-1",
      classificationComplete: false,
      extractionComplete: false,
      extractionStartedAt: new Date(),
    }),
  );
  assert.deepEqual(cell, {
    name: "RE-1",
    secondLine: { kind: "status", status: "analyzing", busy: true },
  });
});

test("describeFileNameCell: 'parsing' takes the second line over the file name", () => {
  const cell = describeFileNameCell(
    makeFile({ extractedInvoiceNumber: "RE-1", extractionComplete: false, extractionStartedAt: new Date() }),
  );
  assert.deepEqual(cell.secondLine, { kind: "status", status: "parsing", busy: true });
});

test("describeFileNameCell: 'notInvoice' takes the second line over the file name", () => {
  const cell = describeFileNameCell(
    makeFile({ extractedInvoiceNumber: "RE-1", isNotInvoice: true }),
  );
  assert.deepEqual(cell.secondLine, { kind: "status", status: "notInvoice", busy: false });
});

// #603: an Extraction waits in a queue until a worker picks it up.
test("describeFileNameCell: 'queued' until a worker picks the File up", () => {
  for (const overrides of [
    { classificationComplete: false, extractionComplete: false },
    // A Retry of a File classified before: still queued, not parsing.
    { classificationComplete: true, extractionComplete: false, extractionStartedAt: null },
  ]) {
    assert.deepEqual(describeFileNameCell(makeFile(overrides)).secondLine, {
      kind: "status",
      status: "queued",
      busy: true,
    });
  }
});

test("describeFileNameCell: a failed Extraction says so instead of looking busy", () => {
  const cell = describeFileNameCell(
    makeFile({ classificationComplete: false, extractionError: "did not finish after 3 attempts" }),
  );
  assert.deepEqual(cell.secondLine, { kind: "status", status: "failed", busy: false });
});

test("describeFileNameCell: a status still shows when the file name is already the name", () => {
  const cell = describeFileNameCell(makeFile({ classificationComplete: false }));
  assert.deepEqual(cell, {
    name: "scan_0042.pdf",
    secondLine: { kind: "status", status: "analyzing", busy: true },
  });
});
