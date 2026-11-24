/**
 * Entry point for the #685 repair: Transactions an MCP import stored before
 * it checked for duplicates (`api_<13 digits>` import ids), stored again by a
 * later CSV import of the same Bank Account. Per pair it keeps the CSV row,
 * moves the API twin's File Connections, Partner and completion onto it
 * through the writers, and removes the API row. The library module is
 * src/transactions/repairApiTwins.ts.
 *
 * Runs in the fibuki-api container (it writes through the shim, so it needs
 * DATABASE_URL, which that container has). Never touches Firebase.
 *
 * A dry run unless --apply is passed. Every run writes the report (JSON) into
 * --out-dir; with --apply it also writes a backup of both rows of every pair
 * it merges and their File Connection records there before the first write.
 * Pairs whose twins hold different Files (or Partners, or Categories) are
 * listed under `decisions` and never touched; a move the File Connection
 * writer would refuse is listed under `blocked`.
 *
 * On fibuki.com, from /opt/fibuki/deploy/selfhost:
 *
 *   DC="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
 *   # open question 2, read-only over every User:
 *   $DC exec -T fibuki-api npm run selfhost:repair-api-twins -- --all-users --out-dir /tmp/twins
 *   # one User's Bank Account: dry run, read the report, then the same with --apply
 *   $DC exec -T fibuki-api npm run selfhost:repair-api-twins -- --user <uid> --source <sourceId> --out-dir /tmp/twins [--apply]
 *   $DC cp fibuki-api:/tmp/twins /root/twins-$(date +%F)
 *
 * /tmp in the container is gone on the next deploy, so copy the files out
 * before then.
 *
 * Exit codes: 0 success (including nothing to do), 1 some pair failed during
 * --apply (see `failed` in the report), 2 usage/config error.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getFirestore } from "firebase-admin/firestore";
import { repairApiTwins, surveyApiTwins } from "../src/transactions/repairApiTwins";

const USAGE = `repair-api-twins: merge Transactions an old MCP import stored twice into their CSV rows (#685)

Usage:
  repair-api-twins --user <uid> --source <sourceId> --out-dir <dir> [--apply]
  repair-api-twins --all-users --out-dir <dir>

Options:
  --user <uid>        the User whose Bank Account is repaired
  --source <id>       the Bank Account (Source) to repair
  --out-dir <dir>     where the report (JSON) and, with --apply, the backup are written
  --apply             merge the pairs (default: dry run, report only)
  --all-users         read-only: list every account whose api_<13 digits> import
                      overlaps a CSV import; refuses --apply
  --dry-run           accepted for clarity; a dry run is the default
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
  const allUsers = args.includes("--all-users");
  const outDir = flagValue(args, "--out-dir");
  const userId = flagValue(args, "--user");
  const sourceId = flagValue(args, "--source");
  if (!outDir) usageError("--out-dir <dir> is required");
  if (allUsers && (apply || userId || sourceId)) usageError("--all-users is read-only and takes no --apply, --user or --source");
  if (!allUsers && (!userId || !sourceId)) usageError("--user <uid> and --source <id> are required (or --all-users)");
  if (apply && args.includes("--dry-run")) usageError("--apply and --dry-run contradict each other");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await fs.mkdir(outDir, { recursive: true });
  const db = getFirestore();

  try {
    if (allUsers) {
      const survey = await surveyApiTwins(db);
      const reportPath = path.join(outDir, `api-twins-survey-${stamp}.json`);
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
    }

    console.log(`repairing API twins of ${userId} / ${sourceId}${apply ? "" : " (dry run)"}`);
    let backupPath: string | null = null;
    const report = await repairApiTwins(db, {
      userId: userId!,
      sourceId: sourceId!,
      apply,
      beforeChange: async (backup) => {
        backupPath = path.join(outDir, `api-twins-backup-${stamp}.json`);
        await fs.writeFile(backupPath, JSON.stringify(backup, null, 2));
      },
    });
    const reportPath = path.join(outDir, `api-twins-report-${stamp}.json`);
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

    const moved = report.merges.reduce((n, m) => n + m.moves.length, 0);
    console.log(
      `\ndone: ${Object.values(report.legacyImports).reduce((a, b) => a + b, 0)} API row(s) in ` +
        `${Object.keys(report.legacyImports).length} legacy import(s); ` +
        `${report.merges.length} pair(s) ${apply ? "merged" : "to merge"} (${moved} File Connection(s) moved); ` +
        `${report.decisions.length} need a decision, ${report.blocked.length} blocked, ` +
        `${report.unmatched.length} without a twin, ${report.ambiguous.length} ambiguous group(s), ` +
        `${report.skipped.length} skipped as changed, ${report.failed.length} failed. Report: ${reportPath}` +
        (backupPath ? `, backup at ${backupPath}` : "")
    );
    for (const d of report.decisions) console.log(`  decide ${d.apiId} / ${d.csvId}: ${d.reason}`);
    for (const b of report.blocked) console.log(`  blocked ${b.apiId} / ${b.csvId}: ${b.reason} (${b.fileId})`);
    for (const f of report.failed) console.log(`  failed ${f.apiId} / ${f.csvId} at ${f.step}: ${f.message}`);
    const invoices = report.merges.flatMap((m) => m.invoiceFileIds);
    if (invoices.length > 0) console.log(`  check the paid state of the invoices of: ${invoices.join(", ")}`);
    process.exit(report.failed.length > 0 ? 1 : 0);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
}

void main();
