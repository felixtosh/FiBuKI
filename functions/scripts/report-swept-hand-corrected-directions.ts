/**
 * Entry point for the #640 report: the Files whose hand-corrected direction an
 * earlier identity sweep may have changed, for the User to re-check. See
 * report-swept-hand-corrected-directions.ts for what counts as evidence and
 * why the list is a superset.
 *
 * A report only: it has no --apply and writes nothing to the database. The
 * JSON goes into --out-dir.
 *
 * Runs in the fibuki-api container (it reads through the shim, so it needs
 * DATABASE_URL, which that container has). Never touches Firebase.
 *
 * On fibuki.com, from /opt/fibuki/deploy/selfhost:
 *
 *   DC="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
 *   $DC exec -T fibuki-api npm run selfhost:report-swept-hand-corrected-directions -- --out-dir /tmp/swept-640 [--user <uid>]
 *   $DC cp fibuki-api:/tmp/swept-640 /root/swept-640-$(date +%F)
 *
 * /tmp in the container is gone on the next deploy, so copy the file out
 * before then.
 *
 * Exit codes: 0 success (including nothing to report), 2 usage/config error.
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { reportSweptHandCorrectedDirections } from "../src/selfhost/report-swept-hand-corrected-directions";

const USAGE = `report-swept-hand-corrected-directions: list Files whose hand-corrected direction an earlier identity sweep may have changed (#640)

Usage:
  report-swept-hand-corrected-directions --out-dir <dir> [--user <userId>]

Options:
  --out-dir <dir>      directory the report JSON is written into
  --user <userId>      only this user's Files and sweep runs (default: every user)
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

  const userId = flagValue(args, "--user");
  const outDir = flagValue(args, "--out-dir");
  if (args.includes("--user") && !userId) usageError("--user needs a userId");
  if (!outDir) usageError("--out-dir <dir> is required");

  console.log(`reading sweep runs and hand-corrected directions ${userId ? `for user ${userId}` : "for every user"}`);

  let report;
  try {
    report = await reportSweptHandCorrectedDirections({ userId });
    await fs.mkdir(outDir, { recursive: true });
    const file = path.join(outDir, `swept-hand-corrected-directions-${Date.now()}.json`);
    await fs.writeFile(file, JSON.stringify(report, null, 2));
    console.log(
      `\ndone: ${report.candidates.length} File(s) to re-check, of ${report.handCorrectedDirections} ` +
        `with a hand-set direction; ${report.runsThatCouldFlip} of ${report.runsRead} sweep run(s) could have ` +
        `flipped one; earliest run on record ${report.earliestRunAt ?? "none"}. Report at ${file}`,
    );
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(2);
  }
  process.exit(0);
}

void main();
