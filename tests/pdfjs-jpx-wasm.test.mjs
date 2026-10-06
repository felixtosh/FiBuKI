// A scanned PDF whose page image is JPEG 2000 (JPXDecode) draws blank unless
// pdf.js gets its wasm decoders (#681). These tests copy the decoders the way
// `prebuild` does and render a synthetic JPEG 2000 scan with them.
//
// The fixture (tests/fixtures/pdf/jpx-scan.pdf, 4.6 KB) is one 240x120 page:
// a black box with a red box inside, encoded as JPEG 2000 by Pillow and wrapped
// by img2pdf. About 39% of its pixels are black when it draws.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyPdfjsWasm, installedPdfjs } from "../scripts/copy-pdfjs-wasm.mjs";
import { PDFJS_WASM_FILES, pdfjsWasmUrl } from "../lib/pdf/pdfjs-wasm.mjs";

const require = createRequire(import.meta.url);
const FIXTURE = new URL("./fixtures/pdf/jpx-scan.pdf", import.meta.url);

/** Share of dark pixels on page 1, rendered by the installed pdf.js. */
async function darkShare(extraOptions) {
  const pdfjs = await import(require.resolve("pdfjs-dist/legacy/build/pdf.mjs"));
  const data = new Uint8Array(readFileSync(FIXTURE));
  const doc = await pdfjs.getDocument({ data, verbosity: 0, ...extraOptions }).promise;
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const { canvas, context } = doc.canvasFactory.create(viewport.width, viewport.height);
    await page.render({ canvasContext: context, canvas, viewport }).promise;
    const pixels = context.getImageData(0, 0, viewport.width, viewport.height).data;
    let dark = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i] < 128 && pixels[i + 3] > 0) dark++;
    }
    return dark / (pixels.length / 4);
  } finally {
    await doc.destroy();
  }
}

test("the decoders land where the viewer's wasmUrl points, for the installed pdf.js", () => {
  const publicDir = mkdtempSync(join(tmpdir(), "fibuki-pdfjs-"));
  try {
    mkdirSync(join(publicDir, "pdfjs", "0.0.1-old"), { recursive: true });
    const target = copyPdfjsWasm(publicDir);
    const { version } = installedPdfjs();

    assert.equal(target, join(publicDir, ...pdfjsWasmUrl(version).split("/").filter(Boolean)));
    for (const file of PDFJS_WASM_FILES) assert.ok(existsSync(join(target, file)), file);
    assert.equal(existsSync(join(publicDir, "pdfjs", "0.0.1-old")), false, "older versions are removed");
  } finally {
    rmSync(publicDir, { recursive: true, force: true });
  }
});

test("the viewer and the worker bundle the same pdf.js the decoders come from", () => {
  const { version } = installedPdfjs();
  const reactPdf = createRequire(require.resolve("react-pdf"));
  const apiVersion = JSON.parse(readFileSync(reactPdf.resolve("pdfjs-dist/package.json"), "utf8")).version;
  assert.equal(apiVersion, version);
});

// One test, in this order: pdf.js keeps the decoder it loaded for the life of
// the process, so the blank render must come before the one that loads it.
test("a JPEG 2000 scan draws blank without wasmUrl and draws with the copied decoders", async () => {
  assert.equal(await darkShare({}), 0, "the fixture must exercise the JPEG 2000 path");

  const publicDir = mkdtempSync(join(tmpdir(), "fibuki-pdfjs-"));
  try {
    const target = copyPdfjsWasm(publicDir);
    const share = await darkShare({ wasmUrl: `${target}/` });
    assert.ok(share > 0.3 && share < 0.5, `expected about 39% dark pixels, got ${share}`);
  } finally {
    rmSync(publicDir, { recursive: true, force: true });
  }
});
