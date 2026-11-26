/**
 * #803 (spec #800, ADR-0018): every automation entry point either asks the
 * one stretch check (`automationScope`, built on `stretchOf`) or says here why
 * it does not need to.
 *
 * The entry points are every Firestore trigger and schedule exported under
 * functions/src, and every entry of the automation registry. A new one fails
 * the first test until it is listed; a listed one whose module no longer asks
 * the check fails the second. So a missed path is caught here rather than
 * silently writing into a filed year.
 *
 * Automation a callable or an MCP tool starts is enumerated from the other
 * end: every module that calls one of the bulk match writers (they rewrite
 * Partner assignments, File suggestions or stored File Connection scores on
 * many records at once) is listed the same way, gated or exempt.
 *
 * What each gate does is driven end to end in
 * selfhost/fiscal-years-automation.test.ts.
 */

import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

const SRC = join(__dirname, "..");
const SKIP_DIRS = new Set(["__tests__", "node_modules", "selfhost"]);
const CHECK = /\bautomationScope\s*\(/;

/** Gated: the modules (under functions/src) where the entry point's work asks the check. */
type Gated = { gate: string[] };
/** Not gated, and why: it works on no Transaction or File, or it is learning. */
type Exempt = { exempt: string };

const MATCHING_FILE = ["matching/matchFilePartner.ts", "matching/matchFileTransactions.ts", "matching/matcher.ts"];
const RECEIPT_SEARCH = ["precision-search/precisionSearchQueue.ts"];
const ONE_RECEIPT_SEARCH = ["workers/runReceiptSearchForTransaction.ts"];
const INSERTS_FILES = "inserts Files; each File's own extraction and matching ask the check";

const ENTRY_POINTS: Record<string, Gated | Exempt> = {
  // Extraction's fact writes
  extractFileData: { gate: ["extraction/extractQueuedFile.ts"] },
  extractFileDataOnUndelete: { gate: ["extraction/extractQueuedFile.ts"] },
  // Partner matching, auto-connect
  matchFilePartner: { gate: ["matching/matchFilePartner.ts"] },
  matchFileTransactions: { gate: ["matching/matchFileTransactions.ts", "matching/matcher.ts"] },
  processOrphanedFiles: { gate: MATCHING_FILE },
  onPartnerCreate: { gate: ["matching/onPartnerCreate.ts"] },
  onPartnerUpdate: { gate: ["matching/onPartnerUpdate.ts"] },
  matchPartners: { gate: ["matching/partnerMatchingShared.ts", "matching/matchFilesForPartner.ts"] },
  // Category matching
  onCategoryCreate: { gate: ["matching/onCategoryCreate.ts"] },
  onCategoryUpdate: { gate: ["matching/onCategoryUpdate.ts"] },
  matchCategories: { gate: ["matching/matchCategories.ts"] },
  onTransactionUpdate: { gate: ["matching/onTransactionUpdate.ts"] },
  // What an Import's completion triggers
  onTransactionsImportedCompanyCheck: {
    gate: ["matching/onTransactionsImportedCompanyCheck.ts", "matching/partnerMatchingShared.ts"],
  },
  onDraftImportCompletedCompanyCheck: {
    gate: ["matching/onTransactionsImportedCompanyCheck.ts", "matching/partnerMatchingShared.ts"],
  },
  onTransactionsImported: { gate: ["gmail/onTransactionsImported.ts", ...RECEIPT_SEARCH] },
  onDraftImportCompleted: { gate: ["gmail/onTransactionsImported.ts", ...RECEIPT_SEARCH] },
  // Receipt search
  processPrecisionSearchQueue: { gate: RECEIPT_SEARCH },
  onPrecisionSearchQueueCreated: { gate: RECEIPT_SEARCH },
  onGmailSyncComplete: { gate: RECEIPT_SEARCH },
  onMailServiceConnected: { gate: RECEIPT_SEARCH },
  onMailServiceReconnected: { gate: RECEIPT_SEARCH },
  scheduledTimedReceiptSearch: { gate: ONE_RECEIPT_SEARCH },
  scheduledMailHeaderScan: { gate: ONE_RECEIPT_SEARCH },
  runReceiptSearchForTransaction: { gate: ONE_RECEIPT_SEARCH },
  // Derived File facts
  onUserDataUpdate: { gate: ["matching/onUserDataUpdate.ts"] },
  // Learning: it reads closed years; the matches it applies ask the check
  processLearningQueue: { gate: ["matching/learnPartnerPatterns.ts"] },
  // Learning reads closed years; the re-score of File Connections it applies asks the check
  scheduledLearnBillingCycles: { gate: ["matching/matcher.ts"] },

  onUserDataCreated: { exempt: "creates the identity Partners; a new Partner's own matching asks the check" },
  onGlobalPartnerWritten: { exempt: "raises the directory version; the catch-up it causes runs Partner matching" },
  searchExternalPartners: { exempt: "a company search the User asks for; writes no Transaction or File" },
  lookupCompany: { exempt: "a company lookup by name or URL; writes no Transaction or File" },
  lookupByVatId: { exempt: "a VIES lookup; writes no Transaction or File" },
  sendWeeklyDigest: { exempt: "the digest's own stretch filter is #802's" },
  onFileConnectionCreatedSyncInvoice: { exempt: "derived Invoice state of a Connection made elsewhere" },
  onFileConnectionDeletedSyncInvoice: { exempt: "derived Invoice state of a Connection taken apart elsewhere" },
  processGmailSyncQueue: { exempt: INSERTS_FILES },
  onSyncQueueCreated: { exempt: INSERTS_FILES },
  syncFolderIntegrations: { exempt: INSERTS_FILES },
  processUserImportOnUpdate: { exempt: "restores a User's own export; inserts are never refused" },
  processBmdExportOnCreate: { exempt: "an export reads, it writes no Transaction or File" },
  processUserExportOnCreate: { exempt: "an export reads, it writes no Transaction or File" },
  processUserExportScheduled: { exempt: "an export reads, it writes no Transaction or File" },
  cleanupExpiredExports: { exempt: "housekeeping of export files" },
  cleanupExpiredDrafts: { exempt: "housekeeping of Import drafts" },
  cleanupOAuth: { exempt: "housekeeping of OAuth state" },
  processPendingDeletions: { exempt: "account deletion" },
  scheduledAggregateGlobalInsights: { exempt: "admin statistics" },
  scheduledRefreshEcbRates: { exempt: "exchange rates" },
  resetInboundDailyLimits: { exempt: "inbound mail counters" },
  communityMembershipSweep: { exempt: "community membership" },
};

/**
 * The bulk match writers: each rewrites stored matches on many records in one
 * run, so whatever calls one is automation, whether a trigger, a callable or
 * an MCP tool started it.
 */
const MATCH_WRITERS = [
  "applyPartnerMatchUpdates",
  "rescoreUnconnectedFilesForPartners",
  "rescoreConnections",
  "writeConnectionScores",
  "rematchAssignedPartners",
];

const PARTNER_MATCHING = ["matching/partnerMatchingShared.ts", "matching/rescorePartnerFiles.ts"];

/** Every module that calls a bulk match writer, by path under functions/src. */
const MATCH_WRITER_CALLERS: Record<string, Gated | Exempt> = {
  // Partner matching: the writes come from the gated matching run; the File re-score after it asks too
  "matching/matchPartners.ts": { gate: PARTNER_MATCHING },
  "matching/onTransactionsImportedCompanyCheck.ts": { gate: PARTNER_MATCHING },
  "matching/partnerProvenance.ts": { gate: PARTNER_MATCHING },
  "matching/partnerMatchingShared.ts": { gate: ["matching/rescorePartnerFiles.ts"] },
  // The whole-account re-match (the rematch_assigned_partners tool) builds its own writes
  "matching/rematchAssignedPartners.ts": { gate: ["matching/rematchAssignedPartners.ts", "matching/rescorePartnerFiles.ts"] },
  "tools/handlers.ts": { gate: ["matching/rematchAssignedPartners.ts"] },
  // The billing-cycle re-score of File Connections (the learn callable, its tool, the schedule)
  "matching/learnBillingCycle.ts": { gate: ["matching/matcher.ts"] },
  "matching/matcher.ts": { gate: ["matching/matcher.ts"] },
  "matching/repairRescoredConnections.ts": {
    exempt: "the one-time #644 repair an admin runs by hand: it corrects scores a bug stored, not automation",
  },
};

function sourceFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return SKIP_DIRS.has(name) ? [] : sourceFiles(path);
    return /\.ts$/.test(name) && !/\.(test|spec)\.ts$/.test(name) ? [path] : [];
  });
}

/** Every exported Firestore trigger and schedule, by export name. */
function triggersAndSchedules(): string[] {
  const names: string[] = [];
  const declaration = /^export const (\w+) = (?:onDocument(?:Created|Updated|Written|Deleted)|onSchedule|onTaskDispatched)\(/gm;
  for (const path of sourceFiles(SRC)) {
    for (const match of readFileSync(path, "utf8").matchAll(declaration)) names.push(match[1]);
  }
  return names;
}

/** Every module that calls a bulk match writer (its definition is no call). */
function matchWriterCallers(): string[] {
  const call = new RegExp(`(?<!function )\\b(?:${MATCH_WRITERS.join("|")})\\s*\\(`);
  return sourceFiles(SRC)
    .filter((path) => call.test(readFileSync(path, "utf8")))
    .map((path) => relative(SRC, path));
}

/** Every id in the automation registry. */
function registryIds(): string[] {
  const source = readFileSync(join(SRC, "automation", "automation-registry.ts"), "utf8");
  const body = source.slice(source.indexOf("AUTOMATION_REGISTRY"), source.indexOf("// QUERY FUNCTIONS"));
  return [...body.matchAll(/^\s+(\w+): \w+,$/gm)].map((m) => m[1]);
}

describe("automation entry points and the stretch check", () => {
  it("lists every trigger, schedule and registered automation as gated or exempt", () => {
    const found = [...new Set([...triggersAndSchedules(), ...registryIds()])].sort();
    expect(registryIds().length).toBeGreaterThan(0);
    const unlisted = found.filter((name) => !(name in ENTRY_POINTS));
    expect(unlisted, "a new automation entry point: gate it with automationScope or list it as exempt").toEqual([]);
    const gone = Object.keys(ENTRY_POINTS).filter((name) => !found.includes(name));
    expect(gone, "listed here but no longer exported").toEqual([]);
  });

  it("lists every module that calls a bulk match writer as gated or exempt", () => {
    const found = matchWriterCallers().sort();
    expect(found).toContain("tools/handlers.ts");
    const unlisted = found.filter((module) => !(module in MATCH_WRITER_CALLERS));
    expect(unlisted, "a new caller of a bulk match writer: gate it with automationScope or list it as exempt").toEqual([]);
    const gone = Object.keys(MATCH_WRITER_CALLERS).filter((module) => !found.includes(module));
    expect(gone, "listed here but no longer calls a bulk match writer").toEqual([]);
  });

  it("finds the check in every module a gated entry point names", () => {
    const missing = Object.entries({ ...ENTRY_POINTS, ...MATCH_WRITER_CALLERS }).flatMap(([name, entry]) =>
      "gate" in entry
        ? entry.gate
            .filter((module) => !CHECK.test(readFileSync(join(SRC, module), "utf8")))
            .map((module) => `${name}: ${relative(SRC, join(SRC, module))}`)
        : []
    );
    expect(missing).toEqual([]);
  });
});
