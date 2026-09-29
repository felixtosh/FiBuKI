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

// --- Purge (#268): the one confirmation in the product that promises permanence ---

import { purgeConfirmation } from "../lib/files/delete-confirmation.js";

test("purgeConfirmation: names the count and states the documents are destroyed", () => {
  const message = purgeConfirmation(3, 0);
  assert.match(message, /3 files/);
  assert.match(message, /destroyed/i);
  assert.match(message, /cannot be undone/i);
});

test("purgeConfirmation: junk purges without ceremony — no retention warning", () => {
  const message = purgeConfirmation(5, 0);
  assert.doesNotMatch(message, /§ 132/);
  assert.doesNotMatch(message, /legally required/i);
});

test("purgeConfirmation: retention-relevant Belege carry the BAO § 132 warning, and still ask rather than refuse", () => {
  const message = purgeConfirmation(5, 2);
  assert.match(message, /2 of them/);
  assert.match(message, /legally required to keep/i);
  assert.match(message, /7 years/);
  assert.match(message, /BAO § 132/);
  assert.match(message, /[Pp]urge anyway\?/);
});

test("purgeConfirmation: when every file is retention-relevant it says so plainly", () => {
  const message = purgeConfirmation(2, 2);
  assert.doesNotMatch(message, /2 of them/);
  assert.match(message, /legally required to keep/i);
});

test("purgeConfirmation: one file reads as one file", () => {
  const message = purgeConfirmation(1, 0);
  assert.match(message, /1 file\?/);
});
