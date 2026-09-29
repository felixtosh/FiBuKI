/**
 * Entry point for the #328 fileHash -> contentHash backfill.
 *
 * Runs on the self-host host with the same environment the API uses (it
 * writes through the shim, so it needs DATABASE_URL). Never touches
 * Firebase, see migrate-file-hash-to-content-hash.ts for why.
 *
 * A dry run unless --apply is passed. With --apply it takes its own backup of
 * every File it rewrites before writing, which is not a substitute for the
 * nightly deploy/selfhost/backup.sh full dump.
 *
 *   npm run selfhost:migrate-file-hash -- [--user <userId>] [--apply --backup-dir <dir>]
 *
 * Exit codes: 0 success (including nothing to do), 2 usage/config error.
 */

import { migrateFileHashToContentHash } from "../src/selfhost/migrate-file-hash-to-content-hash";

const USAGE = `migrate-file-hash: move the Gmail routes' fileHash onto contentHash (#328)

Usage:
  migrate-file-hash [--user <userId>] [--apply --backup-dir <dir>]

Options:
  --user <userId>      only this tenant's Files (default: every tenant)
  --apply              write the changes (default: dry run, report only)
  --backup-dir <dir>   directory the pre-write backup JSON is written into (required with --apply)
  -h, --help           show this help`;

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  const value = i >= 0 ? args[i + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function usageError(message: string): never {
  console.error(`error: ${message}\n`);
  console.error(USAGE);
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("-h") || args.includes("--help")) {
    console.log(USAGE);
    process.exit(0);
  }

  const apply = args.includes("--apply");
  const userId = flagValue(args, "--user");
  const backupDir = flagValue(args, "--backup-dir");

  if (args.includes("--user") && !userId) usageError("--user needs a userId");
  if (apply && !backupDir) usageError("--backup-dir <dir> is required with --apply");

  console.log(
    `moving fileHash to contentHash ${userId ? `for user ${userId}` : "for every tenant"}` +
      (apply ? "" : " (dry run)"),
  );

  let report;
  try {
    report = await migrateFileHashToContentHash({ apply, userId, backupDir });
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  console.log(
    `\ndone: ${report.moved.length} moved, ${report.dropped.length} dropped, ` +
      `${report.conflicts.length} conflict(s), ${report.duplicates.length} duplicate group(s) to resolve by hand, ` +
      `${report.filesScanned} scanned` +
      (report.backupPath ? `, backup at ${report.backupPath}` : ""),
  );
  process.exit(0);
}

void main();
