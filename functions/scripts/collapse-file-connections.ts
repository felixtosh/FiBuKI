/**
 * Entry point for the #612 pass: collapse duplicate File Connection records,
 * remove orphaned ones, and report which writer left them (#597).
 *
 * Run it after #612 is deployed, so no writer creates a duplicate behind it.
 *
 * Runs in the fibuki-api container (it writes through the shim, so it needs
 * DATABASE_URL, which that container has). Never touches Firebase.
 *
 * A dry run unless --apply is passed. Every run writes the report (JSON) into
 * --out-dir; with --apply it also writes a backup of every record it removes
 * there before deleting any.
 *
 * On fibuki.com, from /opt/fibuki/deploy/selfhost:
 *
 *   DC="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
 *   $DC exec -T fibuki-api npm run selfhost:collapse-file-connections -- --out-dir /tmp/fc-pass [--apply]
 *   $DC cp fibuki-api:/tmp/fc-pass /root/fc-pass-$(date +%F)
 *
 * /tmp in the container is gone on the next deploy, so copy the files out
 * before then.
 *
 * Exit codes: 0 success (including nothing to do), 2 usage/config error.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getFirestore } from "firebase-admin/firestore";
import { collapseFileConnections } from "../src/fileConnections/collapse";

const USAGE = `collapse-file-connections: collapse duplicate File Connection records and remove orphaned ones (#612)

Usage:
  collapse-file-connections --out-dir <dir> [--apply]

Options:
  --out-dir <dir>     where the report (JSON) and, with --apply, the backup of removed records are written
  --apply             remove the records (default: dry run, report only)
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
  console.log(`collapsing File Connection records${apply ? "" : " (dry run)"}`);

  let backupPath: string | null = null;
  let report;
  try {
    report = await collapseFileConnections(getFirestore(), {
      apply,
      beforeDelete: async (records) => {
        backupPath = path.join(outDir, `file-connections-removed-${stamp}.json`);
        await fs.writeFile(backupPath, JSON.stringify(records, null, 2));
      },
    });
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const reportPath = path.join(outDir, `file-connections-report-${stamp}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

  console.log(
    `\ndone: ${report.recordsScanned} record(s) scanned, ` +
      `${report.duplicates.length} duplicated pair(s), ${report.orphans.length} orphaned record(s), ` +
      `${report.removedRecords} record(s) ${apply ? "removed" : "to remove"}; ` +
      `${report.halfListed.length} listed on one side only, ${report.unrecorded.length} listed with no record ` +
      `(reported, not changed). Report: ${reportPath}` +
      (backupPath ? `, backup at ${backupPath}` : ""),
  );
  for (const [fingerprint, count] of Object.entries(report.removedByFingerprint)) {
    console.log(`  ${count} x ${fingerprint}`);
  }
  process.exit(0);
}

void main();
