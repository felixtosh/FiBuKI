/**
 * Entry point for the #590 pass: take the Partner/amount precision-search hints
 * off stored Files and list the File Connections those strategies made.
 *
 * Run it only after #589 is deployed, so no new hint of this kind is written
 * behind it. Pass the time #589 went live as --until, so a connection the
 * matcher later made on a #589 nomination is not listed.
 *
 * Runs in the fibuki-api container (it writes through the shim, so it needs
 * DATABASE_URL, which that container has). Never touches Firebase, see
 * src/selfhost/migrate-remove-local-file-hints.ts for why.
 *
 * A dry run unless --apply is passed. Every run writes the review list (CSV)
 * into --out-dir; with --apply it also writes a backup of the removed hints
 * there before deleting them. It disconnects nothing.
 *
 * On fibuki.com, from /opt/fibuki/deploy/selfhost:
 *
 *   DC="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
 *   $DC exec -T fibuki-api npm run selfhost:remove-local-file-hints -- \
 *     --out-dir /tmp/hint-pass --until <#589 deploy time, ISO> [--apply]
 *   $DC cp fibuki-api:/tmp/hint-pass /root/hint-pass-$(date +%F)
 *
 * The list lands as /root/hint-pass-<date>/local-file-hint-connections-<stamp>.csv
 * on the host, the backup beside it as local-file-hints-removed-<stamp>.json.
 * /tmp in the container is gone on the next deploy, so copy them out before then.
 *
 * Exit codes: 0 success (including nothing to do), 2 usage/config error.
 */

import { removeLocalFileHints } from "../src/selfhost/migrate-remove-local-file-hints";

const USAGE = `remove-local-file-hints: remove the Partner/amount precision-search hints from stored Files
and list the File Connections those strategies made (#590)

Usage:
  remove-local-file-hints --out-dir <dir> [--until <ISO date-time>] [--apply]

Options:
  --out-dir <dir>     where the review list (CSV) and, with --apply, the hint backup are written
  --until <time>      only search attempts started before this moment count (the #589 deploy time)
  --apply             remove the hints (default: dry run, list and report only)
  -h, --help          show this help`;

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
  const outDir = flagValue(args, "--out-dir");
  const untilArg = flagValue(args, "--until");

  if (!outDir) usageError("--out-dir <dir> is required");
  if (args.includes("--until") && !untilArg) usageError("--until needs an ISO date-time");
  const until = untilArg ? new Date(untilArg) : undefined;
  if (until && Number.isNaN(until.getTime())) usageError(`--until: not a date-time: ${untilArg}`);

  console.log(
    "removing Partner/amount precision-search hints" +
      (until ? `, listing connections from attempts before ${until.toISOString()}` : "") +
      (apply ? "" : " (dry run)"),
  );
  if (!until) console.log("  warning: no --until, so attempts made after #589 went live count too");

  let report;
  try {
    report = await removeLocalFileHints({ apply, outDir, until });
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  console.log(
    `\ndone: ${report.hintsRemoved.length} hint(s) ${apply ? "removed" : "to remove"}, ` +
      `${report.hintsKept} kept, ${report.connectionsToReview.length} File Connection(s) to review ` +
      `in ${report.listPath}` +
      (report.backupPath ? `, backup at ${report.backupPath}` : ""),
  );
  process.exit(0);
}

void main();
