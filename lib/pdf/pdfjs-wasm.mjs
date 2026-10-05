// Where FiBuKI serves pdf.js's WebAssembly decoders (#681).
//
// pdf.js decodes JPEG 2000 images (most scanners' output) with openjpeg.wasm,
// and ICC colour profiles with qcms_bg.wasm. It fetches them from its
// `wasmUrl` option; without it a scanned page draws without its image.
// scripts/copy-pdfjs-wasm.mjs copies them out of the installed pdfjs-dist
// before every build and dev start, and the PDF viewer and thumbnail pass the
// URL below.
//
// The path carries the pdf.js version, so a page still running the previous
// deploy's worker never pairs it with the next deploy's decoders.

/** The files pdf.js may fetch from `wasmUrl`, plus their licences. */
export const PDFJS_WASM_FILES = [
  "openjpeg.wasm",
  "openjpeg_nowasm_fallback.js",
  "qcms_bg.wasm",
  "LICENSE_OPENJPEG",
  "LICENSE_PDFJS_OPENJPEG",
  "LICENSE_PDFJS_QCMS",
  "LICENSE_QCMS",
];

/** The folder under public/ that holds the decoders. */
export const PDFJS_PUBLIC_DIR = "pdfjs";

/**
 * The same-origin URL pdf.js's `wasmUrl` option gets, with the trailing slash
 * pdf.js requires.
 * @param {string} version the installed pdfjs-dist version
 */
export function pdfjsWasmUrl(version) {
  return `/${PDFJS_PUBLIC_DIR}/${version}/wasm/`;
}
