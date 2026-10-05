/**
 * The before/after diff of two sheets built from the same Replay Set
 * (docs/replay.md): which Files and Transactions the branch would decide
 * differently from `main`, and whether each change agrees with what the
 * account's owner did by hand.
 *
 * Verdicts, per changed row:
 *   now_agrees     the branch now decides what the owner decided by hand
 *   now_disagrees  main agreed with the owner's hand decision, the branch does not
 *   contradicts    the branch would connect or assign something the owner
 *                  rejected, or something other than their hand decision
 *   unverified     changed, and the owner never ruled on it: the rows to look at
 *
 * Only the owner's own decisions count as the answer key: a manual File
 * Connection or an accepted suggestion, a Rejection, a Partner set by hand.
 * An auto-connection the owner never touched is not evidence either way, so a
 * change there is `unverified` and the row says whether the branch matches
 * what is stored today.
 */

import type { FileSheetRow, Sheet, TransactionSheetRow } from "./sheet";

export type Verdict = "now_agrees" | "now_disagrees" | "contradicts" | "unverified";

export const VERDICT_MARK: Record<Verdict, string> = {
  now_agrees: "✅",
  now_disagrees: "❌",
  contradicts: "❌",
  unverified: "❓",
};

export interface FileDiffRow {
  kind: "file";
  id: string;
  name: string;
  amount: number | null;
  date: string | null;
  verdict: Verdict;
  /** One line saying why. */
  because: string;
  before: { autoConnect: string[]; suggestions: string[] };
  after: { autoConnect: string[]; suggestions: string[] };
  truth: FileSheetRow["truth"];
  /** The change is in the suggestion list only; auto-connect is the same. */
  suggestionsOnly: boolean;
}

export interface TransactionDiffRow {
  kind: "transaction";
  id: string;
  name: string;
  amount: number | null;
  date: string | null;
  verdict: Verdict;
  because: string;
  before: { wouldAssign: string | null; top: string | null };
  after: { wouldAssign: string | null; top: string | null };
  truth: TransactionSheetRow["truth"];
}

export type DiffRow = FileDiffRow | TransactionDiffRow;

export interface SheetDiff {
  base: Sheet["meta"];
  head: Sheet["meta"];
  files: { total: number; unchanged: number; rows: FileDiffRow[] };
  transactions: { total: number; unchanged: number; rows: TransactionDiffRow[] };
  counts: Record<Verdict, number>;
}

const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function fileVerdict(before: FileSheetRow, after: FileSheetRow): { verdict: Verdict; because: string } {
  const { manualConnections: manual, automatedConnections: automated, rejected } = after.truth;
  const rejectedHit = after.autoConnect.filter((id) => rejected.includes(id));
  if (rejectedHit.length > 0) {
    return { verdict: "contradicts", because: `would auto-connect a Transaction the owner rejected (${rejectedHit.join(", ")})` };
  }
  if (manual.length > 0) {
    if (sameSet(after.autoConnect, manual)) {
      return sameSet(before.autoConnect, manual)
        ? { verdict: "unverified", because: "auto-connect unchanged and matches the hand connection; suggestions moved" }
        : { verdict: "now_agrees", because: "now auto-connects exactly what the owner connected by hand" };
    }
    const foreign = after.autoConnect.filter((id) => !manual.includes(id) && !automated.includes(id));
    if (foreign.length > 0) {
      return { verdict: "contradicts", because: `would auto-connect ${foreign.join(", ")}, not the owner's hand connection (${manual.join(", ")})` };
    }
    if (sameSet(before.autoConnect, manual)) {
      return { verdict: "now_disagrees", because: "main auto-connected the owner's hand connection; the branch no longer does" };
    }
    return { verdict: "unverified", because: "neither side reproduces the hand connection; the owner should look" };
  }
  if (after.autoConnect.length > 0 && after.autoConnect.every((id) => automated.includes(id))) {
    return { verdict: "unverified", because: "matches the auto-connection stored today (never confirmed by the owner)" };
  }
  if (after.autoConnect.length > 0) {
    return { verdict: "unverified", because: "would auto-connect a Transaction nobody has ruled on" };
  }
  return { verdict: "unverified", because: "no auto-connect either side; suggestions or eligibility moved" };
}

function transactionVerdict(
  before: TransactionSheetRow,
  after: TransactionSheetRow
): { verdict: Verdict; because: string } {
  const { partnerId, partnerMatchedBy } = after.truth;
  const manual = partnerMatchedBy === "manual" ? partnerId : null;
  if (manual) {
    if (after.wouldAssign === manual) {
      return before.wouldAssign === manual
        ? { verdict: "unverified", because: "assignment unchanged and matches the hand-set Partner; candidates moved" }
        : { verdict: "now_agrees", because: "now assigns the Partner the owner set by hand" };
    }
    if (after.wouldAssign) {
      return { verdict: "contradicts", because: `would assign ${after.wouldAssign}, the owner set ${manual}` };
    }
    if (before.wouldAssign === manual) {
      return { verdict: "now_disagrees", because: "main assigned the hand-set Partner; the branch assigns nothing" };
    }
    return { verdict: "unverified", because: "neither side reaches the hand-set Partner" };
  }
  if (after.wouldAssign && after.wouldAssign === partnerId) {
    return { verdict: "unverified", because: `matches the Partner stored today (${partnerMatchedBy ?? "unknown origin"})` };
  }
  return { verdict: "unverified", because: "no hand-set Partner to compare with" };
}

export function diffSheets(base: Sheet, head: Sheet): SheetDiff {
  const counts: Record<Verdict, number> = { now_agrees: 0, now_disagrees: 0, contradicts: 0, unverified: 0 };
  const fileRows: FileDiffRow[] = [];
  let filesUnchanged = 0;
  const fileIds = new Set([...Object.keys(base.files), ...Object.keys(head.files)]);
  for (const id of [...fileIds].sort()) {
    const before = base.files[id];
    const after = head.files[id];
    if (!before || !after) continue; // a File only one side knows: not the same set
    const sameAuto = sameSet(before.autoConnect, after.autoConnect);
    const sameSuggestions = sameList(before.suggestionIds, after.suggestionIds);
    if (sameAuto && sameSuggestions && before.ineligible === after.ineligible) {
      filesUnchanged++;
      continue;
    }
    const { verdict, because } = fileVerdict(before, after);
    counts[verdict]++;
    fileRows.push({
      kind: "file",
      id,
      name: after.name,
      amount: after.amount,
      date: after.date,
      verdict,
      because,
      before: { autoConnect: before.autoConnect, suggestions: before.suggestionIds },
      after: { autoConnect: after.autoConnect, suggestions: after.suggestionIds },
      truth: after.truth,
      suggestionsOnly: sameAuto,
    });
  }

  const txRows: TransactionDiffRow[] = [];
  let txUnchanged = 0;
  const txIds = new Set([...Object.keys(base.transactions), ...Object.keys(head.transactions)]);
  for (const id of [...txIds].sort()) {
    const before = base.transactions[id];
    const after = head.transactions[id];
    if (!before || !after) continue;
    if (before.wouldAssign === after.wouldAssign && before.top?.partnerId === after.top?.partnerId) {
      txUnchanged++;
      continue;
    }
    const { verdict, because } = transactionVerdict(before, after);
    counts[verdict]++;
    txRows.push({
      kind: "transaction",
      id,
      name: after.name,
      amount: after.amount,
      date: after.date,
      verdict,
      because,
      before: { wouldAssign: before.wouldAssign, top: before.top?.partnerId ?? null },
      after: { wouldAssign: after.wouldAssign, top: after.top?.partnerId ?? null },
      truth: after.truth,
    });
  }

  const order: Verdict[] = ["contradicts", "now_disagrees", "unverified", "now_agrees"];
  const byVerdict = (a: { verdict: Verdict }, b: { verdict: Verdict }) =>
    order.indexOf(a.verdict) - order.indexOf(b.verdict);
  fileRows.sort(byVerdict);
  txRows.sort(byVerdict);

  return {
    base: base.meta,
    head: head.meta,
    files: { total: fileIds.size, unchanged: filesUnchanged, rows: fileRows },
    transactions: { total: txIds.size, unchanged: txUnchanged, rows: txRows },
    counts,
  };
}

const cents = (n: number | null) => (n == null ? "?" : (n / 100).toFixed(2));
const list = (ids: string[]) => (ids.length === 0 ? "none" : ids.join(", "));

/** The diff as Markdown: the summary first, then every changed row, worst first. */
export function renderDiffMarkdown(diff: SheetDiff, maxRows = 200): string {
  const lines: string[] = [];
  lines.push(`# Replay: ${diff.head.label} vs ${diff.base.label}`);
  lines.push("");
  lines.push(`Set: ${diff.head.setLabel} (user ${diff.head.userId}, exported ${diff.head.setExportedAt})`);
  lines.push(`Base: ${diff.base.label} at ${diff.base.gitSha ?? "?"}, built ${diff.base.builtAt}`);
  lines.push(`Head: ${diff.head.label} at ${diff.head.gitSha ?? "?"}, built ${diff.head.builtAt}`);
  lines.push("");
  lines.push("| | Files | Transactions |");
  lines.push("|---|---:|---:|");
  lines.push(`| in the set | ${diff.files.total} | ${diff.transactions.total} |`);
  lines.push(`| unchanged | ${diff.files.unchanged} | ${diff.transactions.unchanged} |`);
  lines.push(`| changed | ${diff.files.rows.length} | ${diff.transactions.rows.length} |`);
  lines.push("");
  lines.push(`- ${VERDICT_MARK.now_agrees} now agrees with a hand decision: ${diff.counts.now_agrees}`);
  lines.push(`- ${VERDICT_MARK.now_disagrees} no longer agrees with a hand decision: ${diff.counts.now_disagrees}`);
  lines.push(`- ${VERDICT_MARK.contradicts} contradicts a hand decision or a Rejection: ${diff.counts.contradicts}`);
  lines.push(`- ${VERDICT_MARK.unverified} changed, nobody has ruled on it: ${diff.counts.unverified}`);
  lines.push("");
  if (diff.counts.contradicts === 0 && diff.counts.now_disagrees === 0) {
    lines.push(
      diff.files.rows.length + diff.transactions.rows.length === 0
        ? "**No behaviour change.** The branch decides every File and Transaction as main does."
        : "**Nothing got worse against the hand decisions.** Read the ❓ rows."
    );
  } else {
    lines.push("**Something got worse.** Start with the ❌ rows.");
  }
  lines.push("");

  const fileRows = diff.files.rows.slice(0, maxRows);
  if (fileRows.length > 0) {
    lines.push(`## Files (${diff.files.rows.length} changed)`);
    lines.push("");
    lines.push("| | File | Amount | Date | Auto-connect before → after | Suggestions before → after | Hand decision | Why |");
    lines.push("|---|---|---:|---|---|---|---|---|");
    for (const r of fileRows) {
      const hand =
        r.truth.manualConnections.length > 0
          ? `connected ${list(r.truth.manualConnections)}`
          : r.truth.rejected.length > 0
            ? `rejected ${list(r.truth.rejected)}`
            : "none";
      lines.push(
        `| ${VERDICT_MARK[r.verdict]} | ${r.name} (${r.id}) | ${cents(r.amount)} | ${r.date ?? "?"} | ` +
          `${list(r.before.autoConnect)} → ${list(r.after.autoConnect)} | ` +
          `${list(r.before.suggestions)} → ${list(r.after.suggestions)} | ${hand} | ${r.because} |`
      );
    }
    lines.push("");
  }

  const txRows = diff.transactions.rows.slice(0, maxRows);
  if (txRows.length > 0) {
    lines.push(`## Transactions, Partner assignment (${diff.transactions.rows.length} changed)`);
    lines.push("");
    lines.push("| | Transaction | Amount | Date | Would assign before → after | Top candidate before → after | Stored Partner | Why |");
    lines.push("|---|---|---:|---|---|---|---|---|");
    for (const r of txRows) {
      const stored = r.truth.partnerId ? `${r.truth.partnerId} (${r.truth.partnerMatchedBy ?? "?"})` : "none";
      lines.push(
        `| ${VERDICT_MARK[r.verdict]} | ${r.name} (${r.id}) | ${cents(r.amount)} | ${r.date ?? "?"} | ` +
          `${r.before.wouldAssign ?? "none"} → ${r.after.wouldAssign ?? "none"} | ` +
          `${r.before.top ?? "none"} → ${r.after.top ?? "none"} | ${stored} | ${r.because} |`
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}
