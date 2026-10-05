/**
 * Entry point for the one-off pass that restates net line items as gross
 * (see migrate-gross-up-net-line-items.ts for what it rewrites and skips).
 *
 * Runs on the self-host host with the same environment the API uses (it
 * writes through the shim, so it needs DATABASE_URL). Never touches
 * Firebase. Run it after the reconciliation change is deployed, dry run
 * first; it takes its own backup of every row array it rewrites.
 *
 *   npm run selfhost:gross-up-net-line-items -- --backup-dir <dir> [--dry-run]
 *
 * Exit codes: 0 success (including nothing to do), 2 usage/config error.
 */

import { grossUpNetLineItems } from "../src/selfhost/migrate-gross-up-net-line-items";

const USAGE = `gross-up-net-line-items — restate stored net line items as gross

Usage:
  gross-up-net-line-items --backup-dir <dir> [--dry-run]

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

  console.log(`restating net line items as gross${dryRun ? " (dry run)" : ""}`);

  let report;
  try {
    report = await grossUpNetLineItems({ dryRun, backupDir: backupDir ?? "" });
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  console.log(
    `\ndone: ${report.documentsTouched}/${report.documentsScanned} documents touched, ` +
      `${report.skippedHandCorrected.length} skipped as hand-corrected` +
      (report.backupPath ? `, backup at ${report.backupPath}` : ""),
  );
  process.exit(0);
}

void main();
