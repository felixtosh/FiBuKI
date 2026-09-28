/**
 * Entry point for the #266 Partner name backfill.
 *
 * Runs on the self-host host with the same environment the API uses (it
 * writes through the shim, so it needs DATABASE_URL). Never touches
 * Firebase, see migrate-decode-partner-name-entities.ts for why.
 *
 * A dry run unless --apply is passed. With --apply it takes its own backup of
 * every name and alias list it rewrites before writing, which is not a
 * substitute for the nightly deploy/selfhost/backup.sh full dump.
 *
 *   npm run selfhost:decode-partner-name-entities -- [--user <userId>] [--apply --backup-dir <dir>]
 *
 * Exit codes: 0 success (including nothing to do), 2 usage/config error.
 */

import { decodePartnerNameEntities } from "../src/selfhost/migrate-decode-partner-name-entities";

const USAGE = `decode-partner-name-entities: decode HTML character references in stored Partner names and aliases (#266)

Usage:
  decode-partner-name-entities [--user <userId>] [--apply --backup-dir <dir>]

Options:
  --user <userId>      only this tenant's Partners (default: every tenant)
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
    `decoding Partner names ${userId ? `for user ${userId}` : "for every tenant"}` +
      (apply ? "" : " (dry run)"),
  );

  let report;
  try {
    report = await decodePartnerNameEntities({ apply, userId, backupDir });
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  console.log(
    `\ndone: ${report.changes.length}/${report.partnersScanned} partners ${apply ? "changed" : "would change"}, ` +
      `${report.collisions.length} collision(s) to review for a Merge, ` +
      `${report.unhandled.length} with references left as stored` +
      (report.backupPath ? `, backup at ${report.backupPath}` : ""),
  );
  process.exit(0);
}

void main();
