/**
 * The Files page has one upload pipeline, and one drop on it fires once (#182).
 *
 * It used to carry two: its own hash / duplicate-check / storage-upload /
 * createFile sequence behind the full-page dropzone, and a second copy inside
 * the "Upload File" dialog rendered within that same root. React propagates a
 * synthetic event through the React tree, portalled dialog content included, so
 * one drop ran both — two Files for one document, tens of milliseconds apart.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  createDropReentryGuard,
  dropSignature,
} from "../lib/files/drop-reentry-guard.js";

const invoice = { name: "rechnung.pdf", size: 148221, lastModified: 1757577600000, type: "application/pdf" };
const beleg = { name: "beleg.pdf", size: 90112, lastModified: 1757577600100, type: "application/pdf" };

test("one drop, dispatched twice, is claimed once", () => {
  const guard = createDropReentryGuard();

  // The inner upload zone handles the drop; the event carries on to the
  // full-page dropzone around it, which hands the same files over again.
  assert.ok(guard.claim([invoice]));
  assert.equal(guard.claim([invoice]), null);
});

test("the re-dispatch is refused even with fresh File objects for the same items", () => {
  const guard = createDropReentryGuard();

  guard.claim([invoice]);
  assert.equal(guard.claim([{ ...invoice }]), null);
});

test("the same file can be dropped again once its batch has settled", () => {
  const guard = createDropReentryGuard();

  const claim = guard.claim([invoice]);
  guard.release(claim);

  assert.ok(guard.claim([invoice]));
});

test("a different drop while the first is still uploading is not refused", () => {
  const guard = createDropReentryGuard();

  guard.claim([invoice]);
  assert.ok(guard.claim([beleg]));
});

test("a multi-file drop is one claim, and its re-dispatch is refused", () => {
  const guard = createDropReentryGuard();

  assert.ok(guard.claim([invoice, beleg]));
  assert.equal(guard.claim([invoice, beleg]), null);
  // A subset is a different drop, not this one.
  assert.ok(guard.claim([beleg]));
});

test("an empty drop claims nothing", () => {
  const guard = createDropReentryGuard();

  assert.equal(guard.claim([]), null);
});

test("releasing a claim that was never made is harmless", () => {
  const guard = createDropReentryGuard();

  guard.release(null);
  assert.ok(guard.claim([invoice]));
});

test("dropSignature separates files of the same name but different bytes", () => {
  assert.notEqual(
    dropSignature([invoice]),
    dropSignature([{ ...invoice, size: invoice.size + 1 }])
  );
});

test("the upload pipeline exists once across the Files page and its drop zone", () => {
  const sources = [
    "app/(dashboard)/files/page.tsx",
    "components/files/file-upload-zone.tsx",
  ].map((path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8"));

  const occurrences = (pattern) =>
    sources.reduce((total, src) => total + (src.match(pattern)?.length ?? 0), 0);

  assert.equal(occurrences(/uploadBytesResumable\(/g), 1, "bytes are uploaded in one place");
  assert.equal(occurrences(/createFile\(/g), 1, "the File record is written from one place");
  assert.equal(occurrences(/checkFileDuplicate\(/g), 1, "the duplicate is reported from one place");
});
