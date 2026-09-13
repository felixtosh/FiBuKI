/**
 * Entry point for the #254 line-item field strip.
 *
 * Runs on the self-host host with the same environment the API uses (it
 * writes through the shim, so it needs DATABASE_URL). Never touches
 * Firebase — see migrate-strip-line-item-fields.ts for why.
 *
 * Run only after the #252 shape change has been deployed, and only after a
 * backup exists — this script takes its own targeted backup of every
 * document it is about to rewrite before writing anything, but that is not a
 * substitute for the nightly deploy/selfhost/backup.sh full dump.
 *
 *   npm run selfhost:strip-line-item-fields -- --backup-dir <dir> [--dry-run]
 *
 * Exit codes: 0 success (including nothing to do), 2 usage/config error.
 */

import { stripLineItemFields } from "../src/selfhost/migrate-strip-line-item-fields";

const USAGE = `strip-line-item-fields — drop quantity/unitPrice from stored extractedLineItems (#254)

Usage:
  strip-line-item-fields --backup-dir <dir> [--dry-run]

Options:
  --backup-dir <dir>   directory the pre-write backup JSON is written into (required unless --dry-run)
  --dry-run            report what would change, write nothing, take no backup
  -h, --help           show this help`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    console.log(USAGE);
    process.exit(0);
  }

  const dryRun = args.includes("--dry-run");
  const dirFlagIndex = args.findIndex((a) => a === "--backup-dir");
  const backupDir = dirFlagIndex >= 0 ? args[dirFlagIndex + 1] : undefined;

  if (!dryRun && !backupDir) {
    console.error("error: --backup-dir <dir> is required (or pass --dry-run)\n");
    console.error(USAGE);
    process.exit(2);
  }

  console.log(`stripping quantity/unitPrice from extractedLineItems${dryRun ? " (dry run)" : ""}`);

  let report;
  try {
    report = await stripLineItemFields({ dryRun, backupDir: backupDir ?? "" });
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  console.log(
    `\ndone: ${report.documentsTouched}/${report.documentsScanned} documents touched, ` +
      `${report.rowsRewritten} row(s) rewritten` +
      (report.backupPath ? `, backup at ${report.backupPath}` : ""),
  );
  process.exit(0);
}

void main();
