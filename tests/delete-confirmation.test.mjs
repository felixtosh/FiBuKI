import test from "node:test";
import assert from "node:assert/strict";
import {
  fileDeleteConfirmation,
  bulkFileDeleteConfirmation,
} from "../lib/files/delete-confirmation.js";

const PERMANENCE = /permanent|cannot be undone|forever/i;

test("fileDeleteConfirmation: names the file and promises it can be restored", () => {
  const message = fileDeleteConfirmation("rechnung.pdf");
  assert.match(message, /"rechnung\.pdf"/);
  assert.match(message, /restored/);
});

test("fileDeleteConfirmation: promises no permanence, whatever the source (#258)", () => {
  assert.doesNotMatch(fileDeleteConfirmation("rechnung.pdf"), PERMANENCE);
  assert.doesNotMatch(fileDeleteConfirmation("gmail-attachment.pdf"), PERMANENCE);
});

test("fileDeleteConfirmation: still warns that connections do not come back", () => {
  assert.match(fileDeleteConfirmation("rechnung.pdf"), /connections to transactions are removed/);
});

test("bulkFileDeleteConfirmation: counts the files and promises they can be restored", () => {
  const message = bulkFileDeleteConfirmation(12);
  assert.match(message, /12 files/);
  assert.match(message, /restored/);
  assert.doesNotMatch(message, PERMANENCE);
});

test("bulkFileDeleteConfirmation: a single file reads as one file, not one files", () => {
  const message = bulkFileDeleteConfirmation(1);
  assert.match(message, /1 file\?/);
  assert.match(message, /It will be hidden/);
});
