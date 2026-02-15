export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import JSZip from "jszip";

const EXTENSION_DIR = path.join(process.cwd(), "extensions", "taxstudio-browser");

const EXCLUDED = new Set([
  "node_modules",
  ".git",
  "package-lock.json",
  "jest.config.js",
]);

async function addDirToZip(zip: JSZip, dirPath: string, zipPrefix: string) {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDED.has(entry.name)) continue;
    const fullPath = path.join(dirPath, entry.name);
    const zipPath = zipPrefix ? `${zipPrefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      await addDirToZip(zip, fullPath, zipPath);
    } else {
      const content = await fs.readFile(fullPath);
      zip.file(zipPath, content);
    }
  }
}

export async function GET() {
  try {
    await fs.access(EXTENSION_DIR);
  } catch {
    return NextResponse.json(
      { error: "Extension source not found" },
      { status: 404 }
    );
  }

  const zip = new JSZip();
  await addDirToZip(zip, EXTENSION_DIR, "taxstudio-browser");

  const buffer = await zip.generateAsync({ type: "nodebuffer" });

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": "attachment; filename=taxstudio-browser-extension.zip",
    },
  });
}
