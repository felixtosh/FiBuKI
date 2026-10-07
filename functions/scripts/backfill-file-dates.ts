/**
 * Entry point for the #641 backfill: store every File's Due Date and Debit
 * Date as the File facts module derives them, so the scorer, which reads
 * stored dates only since #641, matches old Files the way it matches new ones.
 *
 * Run it right after the #641 deploy, before the next bank import: until it
 * has run, a File that stored no date scores without the date the scorer used
 * to read off its rows on the fly. Run it after the #619 SEPA pass.
 *
 * Runs in the fibuki-api container (it writes through the shim, so it needs
 * DATABASE_URL, which that container has). Never touches Firebase.
 *
 * A dry run unless --apply is passed. Every run writes the report (JSON) into
 * --out-dir: how many Files gain, change or lose a Due Date or Debit Date, how
 * many inversions (a date before the issue date, #135) it fixes, the Files it
 * skips for a Hand Correction, and each changed File from and to. With
 * --apply the planned list is written first, before the first File is
 * touched. Idempotent: a second --apply writes nothing, so a run that failed
 * part-way is finished by running it again.
 *
 * --apply needs a scope: --user <uid> for one user's Files, or --all-users for
 * every user's. fibuki.com is one tenant with many users.
 *
 * On fibuki.com, from /opt/fibuki/deploy/selfhost:
 *
 *   DC="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
 *   $DC exec -T fibuki-api npm run selfhost:backfill-file-dates -- --out-dir /tmp/dates-641 [--user <uid>]
 *   $DC exec -T fibuki-api npm run selfhost:backfill-file-dates -- --out-dir /tmp/dates-641 --all-users --apply
 *   $DC cp fibuki-api:/tmp/dates-641 /root/dates-641-$(date +%F)
 *
 * /tmp in the container is gone on the next deploy, so copy the files out
 * before then.
 *
 * Exit codes: 0 success (including nothing to do), 2 usage/config error.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { backfillFileDates } from "../src/selfhost/backfill-file-dates";

const USAGE = `backfill-file-dates: store every File's Due Date and Debit Date as the File facts module derives them (#641)

Usage:
  backfill-file-dates --out-dir <dir> [--user <uid> | --all-users]
  backfill-file-dates --out-dir <dir> (--user <uid> | --all-users) --apply

Options:
  --out-dir <dir>     where the report (JSON) is written
  --user <uid>        only this user's Files
  --all-users         every user's Files on the deployment (a dry run without
                      --user covers every user too; --apply needs it said)
  --apply             write the dates (default: dry run, report only);
                      refused without --user or --all-users
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
  const userId = flagValue(args, "--user");
  const allUsers = args.includes("--all-users");
  if (!outDir) usageError("--out-dir <dir> is required");
  if (args.includes("--user") && !userId) usageError("--user needs a uid");
  if (userId && allUsers) usageError("--user and --all-users exclude each other");
  if (apply && !userId && !allUsers) {
    usageError("--apply needs --user <uid> or --all-users: it writes other people's Files on a shared deployment");
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await fs.mkdir(outDir, { recursive: true });
  console.log(
    `storing Due Dates and Debit Dates` +
      (userId ? ` (user ${userId} only)` : " (every user on the deployment)") +
      (apply ? "" : " (dry run)")
  );

  let report;
  try {
    report = await backfillFileDates({
      apply,
      userId,
      allUsers,
      // The from -> to list is on disk before the first write, so a run that
      // fails part-way still says which Files it set out to change.
      beforeWrite: async (planned) => {
        const plannedPath = path.join(outDir, `file-dates-planned-${stamp}.json`);
        await fs.writeFile(plannedPath, JSON.stringify(planned, null, 2));
        console.log(`planned changes written to ${plannedPath}`);
      },
    });
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const reportPath = path.join(outDir, `file-dates-report-${stamp}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

  const covers =
    report.scope.kind === "user"
      ? `user ${report.scope.userId} only`
      : `every user on the deployment, ${report.users.length} with changes` +
        (report.users.length > 0 ? ` (${report.users.map((u) => `${u.userId}: ${u.changed}`).join(", ")})` : "");
  const counts = (c: { gained: number; changed: number; lost: number }) =>
    `${c.gained} gained, ${c.changed} changed, ${c.lost} lost`;
  console.log(
    `\n${apply ? "done" : "dry run"} (${covers}): ${report.filesChanged} of ${report.filesScanned} File(s) ` +
      `${apply ? "written" : "would change"}. Due Date: ${counts(report.dueDate)}. ` +
      `Debit Date: ${counts(report.debitDate)}. Inversions fixed: ${report.inversionsFixed.dueDate} Due Date, ` +
      `${report.inversionsFixed.debitDate} Debit Date. ${report.scoredOnTheFly} File(s) were scored on a date ` +
      `read on the fly. Skipped: ${report.skippedHandCorrected.length} hand-corrected, ` +
      `${report.skippedInPipeline.length} in their Extraction pipeline.` +
      (apply ? ` ${report.refused.length} refused, ${report.failed.length} failed.` : "") +
      ` Report: ${reportPath}`
  );
  for (const s of report.skippedHandCorrected) {
    console.log(`  hand-corrected ${s.fileId} (${s.fields.join(", ")}): skipped`);
  }
  for (const r of report.refused) console.log(`  refused ${r.fileId}: ${r.reason}`);
  for (const f of report.failed) console.log(`  failed ${f.fileId}: ${f.error}`);
  process.exit(0);
}

void main();
