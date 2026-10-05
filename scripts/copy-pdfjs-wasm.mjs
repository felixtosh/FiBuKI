// Copies pdf.js's wasm decoders from the installed pdfjs-dist into
// public/pdfjs/<version>/wasm/, where the PDF viewer and thumbnail fetch them
// (#681, lib/pdf/pdfjs-wasm.mjs). Runs as `prebuild` and `predev`, so the
// self-host image (`npm run build` in web.Dockerfile) always serves the
// decoders of the pdf.js it bundled. Older versions' folders are removed.
//
// The copies are build output, not source: public/pdfjs/ is gitignored.

import { copyFileSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { PDFJS_PUBLIC_DIR, PDFJS_WASM_FILES, pdfjsWasmUrl } from "../lib/pdf/pdfjs-wasm.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The pdfjs-dist the app bundles: resolved from the repo root, like the worker. */
export function installedPdfjs() {
  const require = createRequire(join(repoRoot, "package.json"));
  const packageJson = require.resolve("pdfjs-dist/package.json");
  const { version } = JSON.parse(readFileSync(packageJson, "utf8"));
  return { version, wasmDir: join(dirname(packageJson), "wasm") };
}

/**
 * @param {string} publicDir the folder Next serves at /
 * @returns {string} the folder the decoders were copied to
 */
export function copyPdfjsWasm(publicDir) {
  const { version, wasmDir } = installedPdfjs();
  const target = join(publicDir, ...pdfjsWasmUrl(version).split("/").filter(Boolean));
  const root = join(publicDir, PDFJS_PUBLIC_DIR);

  mkdirSync(root, { recursive: true });
  for (const entry of readdirSync(root)) {
    if (entry !== version) rmSync(join(root, entry), { recursive: true, force: true });
  }
  mkdirSync(target, { recursive: true });
  for (const file of PDFJS_WASM_FILES) {
    copyFileSync(join(wasmDir, file), join(target, file));
  }
  return target;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const target = copyPdfjsWasm(join(repoRoot, "public"));
  console.log(`pdf.js wasm decoders -> ${target.slice(repoRoot.length + 1)}`);
}
