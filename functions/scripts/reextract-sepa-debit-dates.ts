/**
 * Entry point for the #619 sweep: re-extract Files whose SEPA collection
 * sentence ("wird frühestens am ... eingezogen") was stored as a Due Date
 * only, so they gain their Debit Date.
 *
 * Run it after the #619 prompt is deployed, and after one real File has been
 * re-extracted by hand and shown to carry a Debit Date.
 *
 * Runs in the fibuki-api container (it reads and queues through the shim, so
 * it needs DATABASE_URL, which that container has). The Extractions run on
 * that container's extraction worker; an applied run waits for them.
 *
 * A dry run unless --apply is passed: it lists the candidate Files and which
 * of them are hand-corrected (those are skipped, never overwritten). Every
 * run writes the report (JSON) into --out-dir.
 *
 * On fibuki.com, from /opt/fibuki/deploy/selfhost:
 *
 *   DC="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
 *   $DC exec -T fibuki-api npm run selfhost:reextract-sepa-debit-dates -- --out-dir /tmp/sepa-pass [--user <uid>] [--apply]
 *   $DC cp fibuki-api:/tmp/sepa-pass /root/sepa-pass-$(date +%F)
 *
 * /tmp in the container is gone on the next deploy, so copy the files out
 * before then.
 *
 * Exit codes: 0 success (including nothing to do), 2 usage/config error.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { migrateSepaDebitDate } from "../src/selfhost/migrate-sepa-debit-date";

const USAGE = `reextract-sepa-debit-dates: re-extract Files whose SEPA collection sentence became a Due Date only (#619)

Usage:
  reextract-sepa-debit-dates --out-dir <dir> [--user <uid>] [--timeout-minutes <n>] [--apply]

Options:
  --out-dir <dir>         where the report (JSON) is written
  --user <uid>            only this user's Files (default: every user on the deployment)
  --timeout-minutes <n>   how long an applied run waits for the Extractions (default 60)
  --apply                 queue the re-extractions and wait for them (default: dry run, list only)
  -h, --help              show this help`;

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
  const userId = flagValue(args, "--user");
  const timeoutArg = flagValue(args, "--timeout-minutes");
  if (!outDir) usageError("--out-dir <dir> is required");
  if (args.includes("--user") && !userId) usageError("--user needs a uid");
  const timeoutMinutes = timeoutArg === undefined ? 60 : Number(timeoutArg);
  if (!Number.isFinite(timeoutMinutes) || timeoutMinutes <= 0) {
    usageError(`--timeout-minutes: not a positive number: ${timeoutArg}`);
  }

  await fs.mkdir(outDir, { recursive: true });
  console.log(
    `re-extracting Files with a SEPA collection sentence and no Debit Date` +
      (userId ? ` (user ${userId})` : "") +
      (apply ? "" : " (dry run)"),
  );

  let report;
  try {
    report = await migrateSepaDebitDate({ apply, userId, timeoutMs: timeoutMinutes * 60 * 1000 });
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const reportPath = path.join(outDir, `sepa-debit-date-report-${stamp}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

  const handCorrected = report.candidates.filter((c) => c.handCorrected.length > 0).length;
  console.log(
    apply
      ? `\ndone: ${report.candidates.length} candidate(s) of ${report.filesScanned} File(s); ` +
          `${report.gainedDebitDate.length} gained a Debit Date, ${report.noDebitDate.length} still have none, ` +
          `${report.skippedHandCorrected.length} skipped as hand-corrected, ${report.failed.length} failed, ` +
          `${report.refused.length} refused, ${report.stillRunning.length} still running. Report: ${reportPath}`
      : `\ndry run: ${report.candidates.length} candidate(s) of ${report.filesScanned} File(s), ` +
          `${handCorrected} hand-corrected (would be skipped). Report: ${reportPath}`,
  );
  for (const f of report.failed) console.log(`  failed ${f.fileId}: ${f.error}`);
  for (const r of report.refused) console.log(`  refused ${r.fileId}: ${r.reason}`);
  for (const id of report.stillRunning) console.log(`  still running ${id}: check it later`);
  process.exit(0);
}

void main();
