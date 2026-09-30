/**
 * Entry point for the #136 transactionType backfill.
 *
 * Runs on the self-host host with the same environment the API uses (it
 * writes through the shim, so it needs DATABASE_URL). Never touches
 * Firebase, see migrate-transaction-type.ts for why.
 *
 * A dry run unless --apply is passed. With --apply it takes its own backup of
 * every Transaction it rewrites before writing, which is not a substitute for the
 * nightly deploy/selfhost/backup.sh full dump.
 *
 *   npm run selfhost:migrate-transaction-type -- [--user <userId>] [--apply --backup-dir <dir>]
 *
 * Exit codes: 0 success (including nothing to do), 2 usage/config error.
 */

import { migrateTransactionType } from "../src/selfhost/migrate-transaction-type";

const USAGE = `migrate-transaction-type: derive transactionType for Transactions imported before it existed (#136)

Usage:
  migrate-transaction-type [--user <userId>] [--apply --backup-dir <dir>]

Options:
  --user <userId>      only this tenant's Transactions (default: every tenant)
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
    `deriving transactionType ${userId ? `for user ${userId}` : "for every tenant"}` +
      (apply ? "" : " (dry run)"),
  );

  let report;
  try {
    report = await migrateTransactionType({ apply, userId, backupDir });
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  console.log(
    `\ndone: ${report.typed.length} typed, ${report.unknown.length} unknown, ` +
      `${report.noTypeColumn} without a type column, ${report.transactionsScanned} scanned` +
      (report.backupPath ? `, backup at ${report.backupPath}` : ""),
  );
  process.exit(0);
}

void main();
