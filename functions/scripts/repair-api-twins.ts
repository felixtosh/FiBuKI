/**
 * Entry point for the #685 repair: Transactions an MCP import stored before
 * it checked for duplicates (`api_<13 digits>` import ids), stored again by a
 * later CSV import of the same Bank Account. Per pair it keeps the CSV row,
 * moves the API twin's File Connections, Partner and completion onto it
 * through the writers, and removes the API row. The library module is
 * src/transactions/repairApiTwins.ts; arguments and summary in
 * src/transactions/repairApiTwinsCli.ts.
 *
 * Runs in the fibuki-api container (it writes through the shim, so it needs
 * DATABASE_URL, which that container has). Never touches Firebase.
 *
 * A dry run unless --apply is passed, and --apply merges only the pairs the
 * reviewed dry run's report lists (--reviewed), while they still plan the
 * same. Every run writes the report (JSON) into --out-dir, also when it
 * stops on an error. With --apply it first writes a backup of what it may
 * change: both rows of every pair, their File Connection records, their
 * Files and invoices, the Partners and Categories, the subscription count.
 * The backup is for reading and for a hand repair; there is no restore tool,
 * so it is not an undo.
 *
 * Pairs whose twins hold different Files, Partners or Categories, or API-twin
 * work no writer moves, are listed under `decisions` and never touched; a
 * move the File Connection writer would refuse is listed under `blocked`.
 *
 * On fibuki.com, from /opt/fibuki/deploy/selfhost:
 *
 *   DC="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
 *   # open question 2, read-only over every User:
 *   $DC exec -T fibuki-api npm run selfhost:repair-api-twins -- --all-users --out-dir /tmp/twins
 *   # one User's Bank Account: the dry run, then review its report
 *   $DC exec -T fibuki-api npm run selfhost:repair-api-twins -- --user <uid> --source <sourceId> --out-dir /tmp/twins
 *   # the apply of exactly that report (the path the dry run printed)
 *   $DC exec -T fibuki-api npm run selfhost:repair-api-twins -- --user <uid> --source <sourceId> --out-dir /tmp/twins \
 *     --apply --reviewed /tmp/twins/api-twins-report-<stamp>.json
 *   $DC cp fibuki-api:/tmp/twins /root/twins-$(date +%F)
 *
 * /tmp in the container is gone on the next deploy, so copy the files out
 * before then.
 *
 * Exit codes: 0 success (including nothing to do), 1 some pair failed during
 * --apply (see `failed` in the report), 2 usage/config error or a run that
 * stopped on an error.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getFirestore } from "firebase-admin/firestore";
import { repairApiTwins, surveyApiTwins, type RepairReport } from "../src/transactions/repairApiTwins";
import { USAGE, parseRepairArgs, summaryLines } from "../src/transactions/repairApiTwinsCli";

async function main(): Promise<void> {
  const args = parseRepairArgs(process.argv.slice(2));
  if (args.mode === "help") {
    console.log(USAGE);
    process.exit(0);
  }
  if (args.mode === "error") {
    console.error(`error: ${args.message}\n`);
    console.error(USAGE);
    process.exit(2);
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await fs.mkdir(args.outDir, { recursive: true });
  const db = getFirestore();

  if (args.mode === "survey") {
    try {
      const survey = await surveyApiTwins(db);
      const reportPath = path.join(args.outDir, `api-twins-survey-${stamp}.json`);
      await fs.writeFile(reportPath, JSON.stringify(survey, null, 2));
      const overlapping = survey.accounts.filter((a) => a.paired + a.ambiguous > 0);
      console.log(
        `done: ${survey.accounts.length} account(s) hold an api_<13 digits> import, ` +
          `${overlapping.length} overlap a CSV import. Report: ${reportPath}`
      );
      for (const a of survey.accounts) {
        console.log(`  ${a.userId} / ${a.sourceId}: ${a.apiRows} API row(s), ${a.paired} paired, ${a.ambiguous} ambiguous, ${a.unmatched} unmatched`);
      }
      process.exit(0);
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
  }

  let reviewed: RepairReport["merges"] | undefined;
  if (args.apply) {
    try {
      const dry = JSON.parse(await fs.readFile(args.reviewedPath, "utf8")) as RepairReport;
      if (dry.apply !== false || dry.userId !== args.userId || dry.sourceId !== args.sourceId || !Array.isArray(dry.merges)) {
        throw new Error("it is not a dry run's report of this User and Bank Account");
      }
      reviewed = dry.merges;
    } catch (err) {
      console.error(`error: --reviewed ${args.reviewedPath}: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
  }

  console.log(`repairing API twins of ${args.userId} / ${args.sourceId}${args.apply ? "" : " (dry run)"}`);
  const reportPath = path.join(args.outDir, `api-twins-report-${stamp}.json`);
  let backupPath: string | null = null;
  let report: RepairReport | null = null;
  let failure: unknown = null;
  try {
    report = await repairApiTwins(db, {
      userId: args.userId,
      sourceId: args.sourceId,
      apply: args.apply,
      reviewed,
      beforeChange: async (backup) => {
        backupPath = path.join(args.outDir, `api-twins-backup-${stamp}.json`);
        await fs.writeFile(backupPath, JSON.stringify(backup, null, 2));
      },
    });
  } catch (err) {
    failure = err;
  } finally {
    await fs.writeFile(
      reportPath,
      JSON.stringify(report ?? { error: failure instanceof Error ? failure.message : String(failure) }, null, 2)
    );
  }
  if (!report) {
    console.error(`error: ${failure instanceof Error ? failure.message : String(failure)}. Report: ${reportPath}`);
    process.exit(2);
  }
  for (const line of summaryLines(report, { report: reportPath, backup: backupPath })) console.log(line);
  process.exit(report.failed.length > 0 ? 1 : 0);
}

void main();
