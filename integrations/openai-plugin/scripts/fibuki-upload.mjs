#!/usr/bin/env node
/**
 * Upload local receipt/invoice files to FiBuKI.
 *
 *   FIBUKI_API_KEY=fk_... node fibuki-upload.mjs <file> [<file>...]
 *
 * One JSON document on stdout. Byte-identical re-uploads are safe: FiBuKI
 * returns the existing File with duplicate: true instead of creating another.
 * After an upload FiBuKI extracts the document and suggests Matches by itself;
 * this script does none of that.
 *
 * Env: FIBUKI_API_KEY (required), FIBUKI_BASE_URL (default https://fibuki.com).
 */

import { closeSync, fstatSync, openSync, readFileSync } from "node:fs";
import { basename, extname } from "node:path";

const BASE_URL = (process.env.FIBUKI_BASE_URL ?? "https://fibuki.com").replace(/\/$/, "");
// base64 grows a file by a third and the API accepts about 32 MB per request.
const MAX_BYTES = 15 * 1024 * 1024;

const MIME = {
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".heic": "image/heic",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

function finish(payload, code = 0) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(code);
}

async function upload(path, apiKey) {
  const fileName = basename(path);
  const mimeType = MIME[extname(path).toLowerCase()];
  if (!mimeType) return { file: path, ok: false, error: "unsupported type (PDF or image only)" };

  // One open file: the size that is checked is the size that is read.
  let bytes;
  try {
    const fd = openSync(path, "r");
    try {
      if (fstatSync(fd).size > MAX_BYTES) {
        return { file: path, ok: false, error: `larger than ${MAX_BYTES / 1024 / 1024} MB` };
      }
      bytes = readFileSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    return { file: path, ok: false, error: "cannot read file" };
  }

  const response = await fetch(`${BASE_URL}/api/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      tool: "upload_file",
      arguments: { fileName, mimeType, base64: bytes.toString("base64") },
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { file: path, ok: false, error: typeof body.error === "string" ? body.error : `HTTP ${response.status}` };
  }
  const result = body.result ?? body;
  return { file: path, ok: true, fileId: result.fileId ?? result.id ?? null, duplicate: result.duplicate === true };
}

const paths = process.argv.slice(2);
const apiKey = process.env.FIBUKI_API_KEY;
if (paths.length === 0) finish({ ok: false, error: "Usage: fibuki-upload.mjs <file> [<file>...]" }, 1);
if (!apiKey) {
  finish({ ok: false, error: "FIBUKI_API_KEY is not set (run: npx @fibukiapp/cli auth --format env)" }, 1);
}

const results = [];
for (const path of paths) {
  try {
    results.push(await upload(path, apiKey));
  } catch (error) {
    results.push({ file: path, ok: false, error: error instanceof Error ? error.message : String(error) });
  }
}
finish(
  {
    ok: results.every((r) => r.ok),
    uploaded: results.filter((r) => r.ok && !r.duplicate).length,
    duplicates: results.filter((r) => r.ok && r.duplicate).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  },
  results.every((r) => r.ok) ? 0 : 1
);
