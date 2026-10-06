/**
 * Entry point for the #626 inbound email daily limit repair.
 *
 * Runs on the self-host host with the same environment the API uses (it writes
 * through the shim, so it needs DATABASE_URL). Never touches Firebase, see
 * repair-inbound-daily-limits.ts for why.
 *
 * A dry run unless --apply is passed. With --apply it takes its own backup of
 * every limit it rewrites before writing, which is not a substitute for the
 * nightly deploy/selfhost/backup.sh full dump.
 *
 *   npm run selfhost:repair-inbound-daily-limits -- [--user <userId>] [--apply --backup-dir <dir>]
 *
 * Exit codes: 0 success (including nothing to do), 2 usage/config error.
 */

import { repairInboundDailyLimits } from "../src/selfhost/repair-inbound-daily-limits";

const USAGE = `repair-inbound-daily-limits: set every inbound email address's daily limit back to the server's (#626)

Usage:
  repair-inbound-daily-limits [--user <userId>] [--apply --backup-dir <dir>]

Options:
  --user <userId>      only this User's addresses (default: every User)
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
    `repairing inbound email daily limits ${userId ? `for user ${userId}` : "for every User"}` +
      (apply ? "" : " (dry run)"),
  );

  let report;
  try {
    report = await repairInboundDailyLimits({ apply, userId, backupDir });
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  console.log(
    `\ndone: ${report.changed.length}/${report.addressesScanned} addresses ${apply ? "changed" : "would change"}` +
      (report.backupPath ? `, backup at ${report.backupPath}` : ""),
  );
  process.exit(0);
}

void main();
