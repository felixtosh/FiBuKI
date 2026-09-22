import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeFileType,
  classifyPreviewFile,
  previewFileExtensionLabel,
  classifyFileStrict,
} from "../lib/files/file-kind.js";

test("normalizeFileType: a missing fileType normalises to the octet-stream sentinel", () => {
  assert.equal(normalizeFileType(undefined), "application/octet-stream");
  assert.equal(normalizeFileType(null), "application/octet-stream");
  assert.equal(normalizeFileType(""), "application/octet-stream");
});

test("normalizeFileType: a real fileType passes through unchanged", () => {
  assert.equal(normalizeFileType("application/pdf"), "application/pdf");
  assert.equal(normalizeFileType("image/png"), "image/png");
});

test("classifyPreviewFile: a PDF with no stored fileType still classifies as a PDF (#248)", () => {
  const kind = classifyPreviewFile(undefined, "beleg.PDF");
  assert.equal(kind.isPdf, true);
  assert.equal(kind.isImage, false);
  assert.equal(kind.fileType, "application/octet-stream");
});

test("classifyPreviewFile: an image with no stored fileType still classifies as an image (#248)", () => {
  for (const name of ["photo.png", "photo.JPG", "photo.jpeg", "photo.gif", "photo.webp"]) {
    const kind = classifyPreviewFile(undefined, name);
    assert.equal(kind.isImage, true, name);
    assert.equal(kind.isPdf, false, name);
  }
});

test("classifyPreviewFile: no fileType and no recognised extension is neither, not a crash", () => {
  const kind = classifyPreviewFile(undefined, "mystery.bin");
  assert.equal(kind.isPdf, false);
  assert.equal(kind.isImage, false);
});

test("classifyPreviewFile: a declared type still wins over the file name", () => {
  assert.equal(classifyPreviewFile("application/pdf", "photo.png").isPdf, true);
  assert.equal(classifyPreviewFile("image/jpeg", "doc.pdf").isImage, true);
});

test("previewFileExtensionLabel: badges a missing fileType from the extension", () => {
  assert.equal(previewFileExtensionLabel(undefined, "beleg.pdf"), "PDF");
  assert.equal(previewFileExtensionLabel(undefined, "photo.jpeg"), "JPG");
  assert.equal(previewFileExtensionLabel(undefined, "photo.png"), "PNG");
});

test("classifyFileStrict: a missing fileType is neither a PDF nor an image, not a crash (#248)", () => {
  for (const value of [undefined, null, ""]) {
    const kind = classifyFileStrict(value);
    assert.equal(kind.isPdf, false, String(value));
    assert.equal(kind.isImage, false, String(value));
    assert.equal(kind.fileType, "application/octet-stream");
  }
});

test("classifyFileStrict: a PDF or image is still classified without an extension fallback", () => {
  assert.equal(classifyFileStrict("application/pdf").isPdf, true);
  assert.equal(classifyFileStrict("image/png").isImage, true);
});
