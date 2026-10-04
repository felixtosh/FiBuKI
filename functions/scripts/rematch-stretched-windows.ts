/**
 * Entry point for the #614 pass: re-match every unconnected File whose date
 * window a Due Date or Debit Date now stretches past its date + 30 days. It
 * stores suggestions and auto-connects at the normal threshold, as an upload
 * does (suggestions only for a User in passive mode).
 *
 * Run it once, after #614 is deployed.
 *
 * Runs in the fibuki-api container (it writes through the shim, so it needs
 * DATABASE_URL, which that container has). Never touches Firebase.
 *
 * A dry run unless --apply is passed. Every run writes the report (JSON) into
 * --out-dir. A dry run's auto-connect count is an upper bound: an apply runs
 * File by File, so a Transaction one File takes is not taken by the next.
 *
 * On fibuki.com, from /opt/fibuki/deploy/selfhost:
 *
 *   DC="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
 *   $DC exec -T fibuki-api npm run selfhost:rematch-stretched-windows -- --out-dir /tmp/rematch-614 [--apply]
 *   $DC cp fibuki-api:/tmp/rematch-614 /root/rematch-614-$(date +%F)
 *
 * /tmp in the container is gone on the next deploy, so copy the files out
 * before then.
 *
 * Exit codes: 0 success (including nothing to do), 2 usage/config error.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getFirestore } from "firebase-admin/firestore";
import { rematchStretchedWindows } from "../src/matching/stretchedWindowRematch";

const USAGE = `rematch-stretched-windows: re-match unconnected Files whose window a Due Date or Debit Date stretches (#614)

Usage:
  rematch-stretched-windows --out-dir <dir> [--apply]

Options:
  --out-dir <dir>     where the report (JSON) is written
  --apply             store the suggestions and make the auto-connects (default: dry run, report only)
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
  console.log(`re-matching Files with a stretched date window${apply ? "" : " (dry run)"}`);

  let report;
  try {
    report = await rematchStretchedWindows(getFirestore(), { apply });
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }

  const reportPath = path.join(outDir, `rematch-stretched-windows-${stamp}.json`);
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

  console.log(
    `\ndone: ${report.filesScanned} File(s) read, ${report.filesTouched} re-matched, ` +
      `${report.newSuggestions} new suggestion(s), ` +
      `${report.autoConnects} auto-connect(s)${apply ? "" : " at most"}. Report: ${reportPath}`
  );
  process.exit(0);
}

void main();
