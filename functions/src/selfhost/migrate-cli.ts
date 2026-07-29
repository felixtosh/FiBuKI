/**
 * W3 migration dump — importer/verifier CLI (chunk 4). The operator-facing
 * front door to migrate-import.ts, run against the SELFHOST stack:
 *
 *   npm run selfhost:import -- --dir <dump>   [--dry-run]
 *   npm run selfhost:verify -- --dir <dump>
 *
 * Both scripts run through vite-node with the same shim aliases the API host
 * uses (`vite-node --config vitest.selfhost.config.ts` — selfhost:api is the
 * model), so importDump/verifyDump resolve firestore/auth/storage to the
 * selfhost shims and honor DATABASE_URL / FIBUKI_STORAGE / FIBUKI_AUTH_SECRET
 * exactly as the running deployment does.
 *
 * The export half lives on the creds-bearing machine, never here:
 * scripts/export-firebase-dump.ts over real firebase-admin (chunk 4).
 *
 * Exit codes (verify gates the cutover — a runbook step keys off it):
 *   0  success / verify passed
 *   1  verify failed (something missing, mismatched, or checksum-diverged)
 *   2  usage error (bad/missing args)
 *
 * This module is the testable LIBRARY: pure argv in, exit code out, all output
 * through injected writers. The process wrapper (stdio drain + process.exit)
 * lives in migrate-cli-run.ts — vite-node doesn't expose the entry path in
 * argv, so a separate entry file is cleaner than an entrypoint guard here.
 */

import { importDump, verifyDump, type ImportReport, type VerifyReport } from "./migrate-import";

type Writer = (line: string) => void;

const USAGE = `fibuki selfhost migration CLI

  import   restore a version-1 dump into the selfhost stack
  verify   check that a dump is fully present and byte-identical in the target

Usage:
  selfhost:import  --dir <dump-directory> [--dry-run]
  selfhost:verify  --dir <dump-directory>

Options:
  -d, --dir <path>   dump directory (required)
      --dry-run      import: report the plan, write nothing
  -h, --help         show this help`;

interface ParsedArgs {
  command: "import" | "verify";
  dir: string;
  dryRun: boolean;
}

/**
 * Parse argv (already sliced past node/script). Returns the parsed shape, or a
 * string error to print with a usage exit. `--help`/no command returns the
 * usage sentinel so the caller prints help and exits 0.
 */
export function parseArgs(argv: string[]): ParsedArgs | { help: true } | { error: string } {
  if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) {
    return { help: true };
  }

  const [command, ...rest] = argv;
  if (command !== "import" && command !== "verify") {
    return { error: `unknown command "${command}" — expected "import" or "verify"` };
  }

  let dir: string | undefined;
  let dryRun = false;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "-d" || arg === "--dir") {
      dir = rest[++i];
      if (dir === undefined) return { error: `${arg} requires a path` };
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else {
      return { error: `unexpected argument "${arg}"` };
    }
  }

  if (!dir) return { error: "--dir <dump-directory> is required" };
  if (dryRun && command === "verify") return { error: "--dry-run is not valid for verify" };

  return { command, dir, dryRun };
}

function reportImport(report: ImportReport, out: Writer): void {
  out(report.dryRun ? "import — DRY RUN (nothing written):" : "import — done:");
  for (const c of report.collections) {
    out(`  collection ${c.path}: ${c.written}/${c.docs} docs`);
  }
  out(`  users: ${report.users.provisioned.length} provisioned, ${report.users.existing.length} already present`);
  out(`  storage: ${report.storage.written}/${report.storage.objects} objects, ${report.storage.bytes} bytes`);
}

function reportVerify(report: VerifyReport, out: Writer): void {
  out(report.ok ? "verify — PASS" : "verify — FAIL");
  for (const c of report.collections) {
    if (c.missing.length || c.mismatched.length) {
      out(`  collection ${c.path}: ${c.missing.length} missing, ${c.mismatched.length} mismatched (of ${c.expected})`);
      for (const id of c.missing) out(`    missing: ${id}`);
      for (const id of c.mismatched) out(`    mismatched: ${id}`);
    }
  }
  if (report.users.missing.length) {
    out(`  users: ${report.users.missing.length} missing (of ${report.users.expected})`);
    for (const uid of report.users.missing) out(`    missing: ${uid}`);
  }
  if (report.storage.missing.length || report.storage.checksumFailures.length) {
    out(`  storage: ${report.storage.missing.length} missing, ${report.storage.checksumFailures.length} checksum failures (of ${report.storage.expected})`);
    for (const p of report.storage.missing) out(`    missing: ${p}`);
    for (const p of report.storage.checksumFailures) out(`    checksum: ${p}`);
  }
}

/**
 * Run the CLI. Returns the process exit code; never throws for operational
 * failures (a thrown importDump/verifyDump error is caught and mapped to 1).
 */
export async function runCli(argv: string[], out: Writer = console.log, err: Writer = console.error): Promise<number> {
  const parsed = parseArgs(argv);

  if ("help" in parsed) {
    out(USAGE);
    return 0;
  }
  if ("error" in parsed) {
    err(`error: ${parsed.error}\n`);
    err(USAGE);
    return 2;
  }

  try {
    if (parsed.command === "import") {
      reportImport(await importDump({ dir: parsed.dir, dryRun: parsed.dryRun }), out);
      return 0;
    }
    const report = await verifyDump({ dir: parsed.dir });
    reportVerify(report, out);
    return report.ok ? 0 : 1;
  } catch (e) {
    err(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
