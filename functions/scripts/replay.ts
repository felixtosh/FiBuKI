/**
 * Replay: does a branch decide your real account differently from main?
 * See docs/replay.md.
 *
 *   npm run selfhost:replay -- export --user <uid> --out felix.replay-set.json [--label Felix] [--months 12] [--keep-text]
 *   npm run selfhost:replay -- sheet  --set felix.replay-set.json --out main.sheet.json [--label main]
 *   npm run selfhost:replay -- diff   main.sheet.json pr-660.sheet.json [--md report.md] [--json diff.json]
 *   npm run selfhost:replay -- accounts                        (the opted-in accounts, for replay.sh)
 *   npm run selfhost:replay -- verify --bundle bench-2026-10.json
 *   npm run selfhost:replay -- sheet  --bundle bench-2026-10.json --account Felix --out main.sheet.json
 *
 * A bundle is one shared benchmark version, downloaded from fibuki.com/admin/replay
 * (docs/benchmarking.md). `verify` checks its checksum and prints what it holds;
 * `sheet --bundle` verifies it too, and runs one of its accounts.
 *
 * `export` reads one User's matching inputs from the deployment database
 * (DATABASE_URL) and writes nothing there. On fibuki.com:
 *
 *   DC="docker compose -f docker-compose.yml -f docker-compose.prod.yml"
 *   $DC exec -T fibuki-api npm run selfhost:replay -- export --user <uid> --out /tmp/felix.replay-set.json
 *   $DC cp fibuki-api:/tmp/felix.replay-set.json ./felix.replay-set.json
 *
 * `sheet` refuses to run with DATABASE_URL set: it loads the set into an
 * embedded in-memory database and runs the matcher there, so it can be run
 * on any checkout (main, then the branch) without touching a deployment.
 *
 * Exit codes: 0 done, 1 the diff found a ❌ row, 2 usage or config error.
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { getFirestore } from "firebase-admin/firestore";
import { exportReplaySet, loadReplaySet, parseReplaySet, replaySetCounts } from "../src/replay/set";
import { buildSheet, type Sheet } from "../src/replay/sheet";
import { diffSheets, renderDiffMarkdown } from "../src/replay/diff";
import { benchmarkAccounts, BENCHMARK_MONTHS, verifyBundle, type BenchmarkBundle } from "../src/benchmark/benchmarkData";
import { accountLabel } from "../src/benchmark/benchmarkCallables";
import type { ReplaySet } from "../src/replay/set";

const USAGE = `replay: run the matcher over a real account on two commits and diff the decisions

Usage:
  replay export --user <uid> --out <set.json> [--label <name>] [--months <n>] [--keep-text]
                 --months: the most recent calendar months only (default 12; 0 = everything)
  replay sheet  --set <set.json> --out <sheet.json> [--label <name>]
  replay sheet  --bundle <bench-YYYY-MM.json> --account <label|uid> --out <sheet.json> [--label <name>]
  replay diff   <base.sheet.json> <head.sheet.json> [--md <report.md>] [--json <diff.json>]
  replay verify --bundle <bench-YYYY-MM.json>
  replay accounts
                 the accounts in the benchmark, one "<uid> <label> <months>" per line

export and accounts need DATABASE_URL (the deployment). sheet and verify refuse it (embedded database only).`;

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

function gitSha(): string | null {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

function gitBranch(): string | null {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(path, "utf8"));
}

async function runExport(args: string[]): Promise<number> {
  const userId = flagValue(args, "--user");
  const out = flagValue(args, "--out");
  if (!userId) usageError("--user <uid> is required");
  if (!out) usageError("--out <set.json> is required");
  if (!process.env.DATABASE_URL) usageError("export reads the deployment: DATABASE_URL must be set");

  const monthsFlag = flagValue(args, "--months");
  const months = monthsFlag === undefined ? 12 : Number(monthsFlag);
  if (!Number.isInteger(months) || months < 0) usageError("--months needs a whole number of months (0 = everything)");

  const set = await exportReplaySet(getFirestore(), userId, {
    label: flagValue(args, "--label"),
    keepText: args.includes("--keep-text"),
    months: months === 0 ? undefined : months,
  });
  await fs.writeFile(out, JSON.stringify(set));
  const counts = replaySetCounts(set);
  console.log(
    `exported ${set.label} (${months === 0 ? "everything" : `last ${months} months`}): ` +
      `${counts.transactions} transactions, ${counts.files} files, ` +
      `${counts.partners} partners, ${counts.fileConnections} connections, ${counts.globalPartners} global partners` +
      ` -> ${out}`
  );
  console.log("This file holds real bank lines and documents. Keep it out of the repo and share it only with its owner's consent.");
  return 0;
}

/** Read a bundle, verify its checksum, and say which version it is: the scorecard's first line. */
async function readBundle(path: string): Promise<BenchmarkBundle> {
  const bundle = verifyBundle(await readJson(path));
  console.log(`${bundle.version} · checksum ${bundle.checksum.slice(0, 12)} · ${bundle.accounts.map((a) => a.label).join(", ")}`);
  return bundle;
}

async function runVerify(args: string[]): Promise<number> {
  const bundlePath = flagValue(args, "--bundle");
  if (!bundlePath) usageError("--bundle <bench-YYYY-MM.json> is required");
  const bundle = await readBundle(bundlePath);
  for (const set of bundle.accounts) {
    const counts = replaySetCounts(set);
    console.log(`  ${set.label} (${set.userId}): ${counts.transactions} transactions, ${counts.files} files, ${counts.fileConnections} connections`);
  }
  console.log(`checksum verified; built ${bundle.builtAt}, last ${bundle.months} months per account`);
  return 0;
}

async function runAccounts(): Promise<number> {
  if (!process.env.DATABASE_URL) usageError("accounts reads the deployment: DATABASE_URL must be set");
  for (const account of await benchmarkAccounts(getFirestore(), accountLabel)) {
    // replay.sh reads "<uid> <label> [months]"; a label is one word there.
    console.log(`${account.uid} ${account.label.replace(/\s+/g, "_")} ${BENCHMARK_MONTHS}`);
  }
  return 0;
}

async function runSheet(args: string[]): Promise<number> {
  const setPath = flagValue(args, "--set");
  const bundlePath = flagValue(args, "--bundle");
  const out = flagValue(args, "--out");
  if (!setPath && !bundlePath) usageError("--set <set.json> or --bundle <bench-YYYY-MM.json> is required");
  if (!out) usageError("--out <sheet.json> is required");
  if (process.env.DATABASE_URL) {
    usageError("sheet runs on the embedded database only; unset DATABASE_URL (it would load the set into a deployment)");
  }

  let set: ReplaySet;
  if (bundlePath) {
    const which = flagValue(args, "--account");
    if (!which) usageError("--account <label|uid> is required with --bundle");
    const bundle = await readBundle(bundlePath);
    const found = bundle.accounts.find((a) => a.userId === which || a.label.toLowerCase() === which.toLowerCase());
    if (!found) usageError(`no account "${which}" in ${bundle.version}; it holds ${bundle.accounts.map((a) => a.label).join(", ")}`);
    // The version names the data, so two sheets from the same version diff.
    set = { ...found, exportedAt: `${bundle.version}:${bundle.checksum.slice(0, 12)}` };
  } else {
    set = parseReplaySet(await readJson(setPath!));
  }
  const db = getFirestore();
  await loadReplaySet(db, set);
  const sheet = await buildSheet(set.userId, {
    label: flagValue(args, "--label") ?? gitBranch() ?? "unnamed",
    gitSha: gitSha(),
    setLabel: set.label,
    setExportedAt: set.exportedAt,
    log: (line) => console.log(line),
  });
  await fs.writeFile(out, JSON.stringify(sheet, null, 1));
  const autoConnects = Object.values(sheet.files).filter((f) => f.autoConnect.length > 0).length;
  const assigns = Object.values(sheet.transactions).filter((t) => t.wouldAssign).length;
  console.log(
    `sheet ${sheet.meta.label} (${sheet.meta.gitSha ?? "no sha"}): ${Object.keys(sheet.files).length} files ` +
      `(${autoConnects} would auto-connect), ${Object.keys(sheet.transactions).length} transactions ` +
      `(${assigns} would get a Partner) -> ${out}`
  );
  return 0;
}

async function runDiff(args: string[]): Promise<number> {
  const [basePath, headPath] = args.filter((a) => !a.startsWith("--") && a !== flagValue(args, "--md") && a !== flagValue(args, "--json"));
  if (!basePath || !headPath) usageError("diff needs <base.sheet.json> <head.sheet.json>");
  const base = (await readJson(basePath)) as Sheet;
  const head = (await readJson(headPath)) as Sheet;
  if (base.meta.userId !== head.meta.userId || base.meta.setExportedAt !== head.meta.setExportedAt) {
    usageError("the two sheets were built from different sets; build both from the same set file");
  }
  const diff = diffSheets(base, head);
  const md = renderDiffMarkdown(diff);
  const mdPath = flagValue(args, "--md");
  const jsonPath = flagValue(args, "--json");
  if (mdPath) await fs.writeFile(mdPath, md);
  if (jsonPath) await fs.writeFile(jsonPath, JSON.stringify(diff, null, 1));
  console.log(md);
  return diff.counts.contradicts + diff.counts.now_disagrees > 0 ? 1 : 0;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "-h" || command === "--help") {
    console.log(USAGE);
    process.exit(command ? 0 : 2);
  }
  let code: number;
  try {
    if (command === "export") code = await runExport(args);
    else if (command === "sheet") code = await runSheet(args);
    else if (command === "diff") code = await runDiff(args);
    else if (command === "verify") code = await runVerify(args);
    else if (command === "accounts") code = await runAccounts();
    else usageError(`unknown command ${command}`);
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    code = 2;
  }
  process.exit(code);
}

void main();
