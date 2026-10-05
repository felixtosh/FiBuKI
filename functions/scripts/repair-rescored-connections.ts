/**
 * Entry point for the #644 repair: re-score every File Connection the
 * billing-cycle re-score wrote (it carries `rescoredAt`). Before #644 such a
 * connected pair was judged a duplicate of its own invoice and stored
 * confidence 0.
 *
 * Run it once, after the #644 fix is deployed: before it, the re-score would
 * store the same 0 again.
 *
 * Runs in the fibuki-api container (it writes through the shim, so it needs
 * DATABASE_URL, which that container has). Never touches Firebase.
 *
 * A dry run unless --apply is passed. Every run writes the report (JSON) into
 * --out-dir: each record whose score changes, from and to. With --apply that
 * list is written as a "planned" file before the first record is touched.
 * Idempotent: a second --apply writes nothing, so a run that failed part-way
 * is finished by running it again.
 *
 * On fibuki.com, from /opt/fibuki/deploy/selfhost:
 *
 *   DC="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
 *   $DC exec -T fibuki-api npm run selfhost:repair-rescored-connections -- --out-dir /tmp/rescore-644 [--apply]
 *   $DC cp fibuki-api:/tmp/rescore-644 /root/rescore-644-$(date +%F)
 *
 * /tmp in the container is gone on the next deploy, so copy the files out
 * before then.
 *
 * Exit codes: 0 success (including nothing to do), 2 usage/config error.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getFirestore } from "firebase-admin/firestore";
import { repairRescoredConnections } from "../src/matching/repairRescoredConnections";

const USAGE = `repair-rescored-connections: re-score the File Connections the billing-cycle re-score wrote (#644)

Usage:
  repair-rescored-connections --out-dir <dir> [--apply]

Options:
  --out-dir <dir>     where the report (JSON) is written
  --apply             write the fresh scores (default: dry run, report only)
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
  if (!outDir) usageError("--out-dir <dir> is required");

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  await fs.mkdir(outDir, { recursive: true });
  console.log(`re-scoring File Connections that carry rescoredAt${apply ? "" : " (dry run)"}`);

  const reportPath = path.join(outDir, `rescored-connections-report-${stamp}.json`);
  let report;
  try {
    report = await repairRescoredConnections(getFirestore(), {
      apply,
      // The from -> to list is on disk before the first write, so a run that
      // fails part-way still says which records it set out to overwrite.
      beforeWrite: async (planned) => {
        const plannedPath = path.join(outDir, `rescored-connections-planned-${stamp}.json`);
        await fs.writeFile(plannedPath, JSON.stringify(planned, null, 2));
        console.log(`planned changes written to ${plannedPath}`);
      },
    });
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

  console.log(
    `\ndone: ${report.recordsScanned} record(s) with rescoredAt, ` +
      `${report.changed.length} ${apply ? "re-scored" : "to re-score"} ` +
      `(${report.raisedFromZero} of them up from 0), ${report.unchanged} unchanged, ` +
      `${report.skipped.length} skipped, ${report.written} written. Report: ${reportPath}`
  );
  for (const c of report.changed) {
    console.log(`  ${c.connectionId} (${c.fileId} / ${c.transactionId}): ${c.from ?? "unset"} -> ${c.to}`);
  }
  for (const s of report.skipped) {
    console.log(`  skipped ${s.connectionId}: ${s.reason}`);
  }
  process.exit(0);
}

void main();
