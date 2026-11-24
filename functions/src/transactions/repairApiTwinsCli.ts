/**
 * The #685 repair script's arguments and console summary, apart from the
 * script so they can be tested without a database (scripts/repair-api-twins.ts).
 */

import type { RepairReport } from "./repairApiTwins";

export const USAGE = `repair-api-twins: merge Transactions an old MCP import stored twice into their CSV rows (#685)

Usage:
  repair-api-twins --user <uid> --source <sourceId> --out-dir <dir>
  repair-api-twins --user <uid> --source <sourceId> --out-dir <dir> --apply --reviewed <dry-run report.json>
  repair-api-twins --all-users --out-dir <dir>

Options:
  --user <uid>        the User whose Bank Account is repaired
  --source <id>       the Bank Account (Source) to repair
  --out-dir <dir>     where the report (JSON) and, with --apply, the backup are written
  --apply             merge the pairs (default: dry run, report only)
  --reviewed <file>   the dry run's report you reviewed; --apply merges only the
                      pairs it lists, and only while they still plan the same
  --all-users         read-only: list every account whose api_<13 digits> import
                      overlaps a CSV import; refuses --apply
  --dry-run           accepted for clarity; a dry run is the default
  -h, --help          show this help`;

export type RepairArgs =
  | { mode: "help" }
  | { mode: "error"; message: string }
  | { mode: "survey"; outDir: string }
  | { mode: "repair"; userId: string; sourceId: string; outDir: string; apply: false }
  | { mode: "repair"; userId: string; sourceId: string; outDir: string; apply: true; reviewedPath: string };

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  const value = i >= 0 ? args[i + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

export function parseRepairArgs(args: string[]): RepairArgs {
  if (args.includes("-h") || args.includes("--help")) return { mode: "help" };
  const error = (message: string): RepairArgs => ({ mode: "error", message });
  const apply = args.includes("--apply");
  const outDir = flagValue(args, "--out-dir");
  const userId = flagValue(args, "--user");
  const sourceId = flagValue(args, "--source");
  const reviewedPath = flagValue(args, "--reviewed");
  if (!outDir) return error("--out-dir <dir> is required");
  if (args.includes("--all-users")) {
    if (apply || args.includes("--user") || args.includes("--source") || args.includes("--reviewed")) {
      return error("--all-users is read-only and takes no --apply, --user, --source or --reviewed");
    }
    return { mode: "survey", outDir };
  }
  if (!userId || !sourceId) return error("--user <uid> and --source <id> are required (or --all-users)");
  if (!apply) {
    if (args.includes("--reviewed")) return error("--reviewed goes with --apply");
    return { mode: "repair", userId, sourceId, outDir, apply: false };
  }
  if (args.includes("--dry-run")) return error("--apply and --dry-run contradict each other");
  if (!reviewedPath) return error("--apply needs --reviewed <the dry run's report.json>");
  return { mode: "repair", userId, sourceId, outDir, apply: true, reviewedPath };
}

/** The console summary: counts, then one line per pair a person has to look at. */
export function summaryLines(report: RepairReport, paths: { report?: string; backup?: string | null } = {}): string[] {
  const moved = report.merges.reduce((n, m) => n + m.moves.length, 0);
  const lines = [
    `done: ${Object.values(report.legacyImports).reduce((a, b) => a + b, 0)} API row(s) in ` +
      `${Object.keys(report.legacyImports).length} legacy import(s); ` +
      `${report.merges.length} pair(s) ${report.apply ? "merged" : "to merge"} (${moved} File Connection(s) moved); ` +
      `${report.decisions.length} need a decision, ${report.blocked.length} blocked, ` +
      `${report.unmatched.length} without a twin, ${report.ambiguous.length} ambiguous group(s), ` +
      `${report.unpairable.length} unpairable, ${report.skipped.length} skipped, ${report.failed.length} failed.` +
      (paths.report ? ` Report: ${paths.report}` : "") +
      (paths.backup ? `, backup at ${paths.backup}` : ""),
  ];
  for (const d of report.decisions) {
    const detail = d.fields ?? d.referencedBy ?? (d.fileId ? [d.fileId] : undefined);
    lines.push(`  decide ${d.apiId} / ${d.csvId}: ${d.reason}${detail ? ` (${detail.join(", ")})` : ""}`);
  }
  for (const b of report.blocked) lines.push(`  blocked ${b.apiId} / ${b.csvId}: ${b.reason} (${b.fileId})`);
  for (const m of report.merges) for (const n of m.notes) lines.push(`  note ${m.apiId} / ${m.csvId}: ${n}`);
  for (const s of report.skipped) lines.push(`  skipped ${s.apiId} / ${s.csvId}: ${s.reason}`);
  for (const f of report.failed) lines.push(`  failed ${f.apiId} / ${f.csvId} at ${f.step}: ${f.message}`);
  const invoices = report.merges.flatMap((m) => m.invoiceFileIds);
  if (invoices.length > 0) lines.push(`  Files with an invoice (re-pointed if the API twin paid it): ${invoices.join(", ")}`);
  return lines;
}
