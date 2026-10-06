/**
 * The Sheet: what the code at one commit would decide for every File and
 * Transaction of a Replay Set (docs/replay.md). Reads only, writes nothing.
 *
 * Files are scored as if each had just been uploaded, with everything else as
 * it is: the File's own connections are set aside, the Files already on each
 * candidate Transaction still count (the Remainder, #239), Rejections still
 * hold, Partners and Learned Patterns are as stored. So this is the "warm"
 * replay: it answers "would this File land where it landed", not "what does
 * a new user see on day one". Scores and picks come from the one matcher
 * (#613): `transactionsForFiles` and `selectAutoConnects`, the upload
 * trigger's own calls.
 *
 * Transactions get the Partner matcher's answer, with the same skips the
 * write path has (a No-document Category, an over-quota line) and the same
 * `manualRemovals` veto, and a global top match resolved to the local copy
 * the write path would assign.
 *
 * Beside each answer the sheet records the owner's own decisions, which the
 * diff uses as the answer key: hand connections, Rejections, a hand-set
 * Partner.
 */

import { getFirestore } from "firebase-admin/firestore";
import { selectAutoConnects, storedSuggestionsOf, transactionsForFiles, type MatcherFile } from "../matching/matcher";
import { readDismissedTransactionIds } from "../matching/dismissedTransactions";
import { buildPartnerIndex } from "../matching/partnerRematchReport";
import { loadPartnerMatchingContext } from "../matching/partnerMatchingShared";
import { matchTransaction, shouldAutoApply, type TransactionData } from "../utils/partner-matcher";
import { toDateSafe } from "../utils/toDateSafe";

type Data = FirebaseFirestore.DocumentData;

export const SHEET_VERSION = 1;

export interface SheetMeta {
  version: typeof SHEET_VERSION;
  /** What this build is called in the report: a branch, a PR number. */
  label: string;
  gitSha: string | null;
  builtAt: string;
  userId: string;
  setLabel: string;
  setExportedAt: string;
}

export interface FileSheetRow {
  name: string;
  amount: number | null;
  date: string | null;
  partnerId: string | null;
  /** Why the matcher never scores it, when it does not. */
  ineligible: string | null;
  /** What would be stored as `transactionSuggestions`, best first. */
  suggestions: Array<{ transactionId: string; confidence: number; sources: string[] }>;
  /** The ids above, for a cheap compare. */
  suggestionIds: string[];
  /** What the upload trigger would connect by itself. */
  autoConnect: string[];
  truth: {
    /** Connections the owner made or accepted. */
    manualConnections: string[];
    /** Connections the matcher made and nobody touched. */
    automatedConnections: string[];
    /** Rejections on this File. */
    rejected: string[];
  };
}

export interface TransactionSheetRow {
  name: string;
  amount: number | null;
  date: string | null;
  /** The Partner the matcher would assign now, after global-to-local resolution; null below the gate. */
  wouldAssign: string | null;
  top: { partnerId: string; partnerName: string; confidence: number; source: string } | null;
  /** Why the Partner matcher skipped it, when it did. */
  skipped: "no-document-category" | "over-quota" | null;
  truth: { partnerId: string | null; partnerMatchedBy: string | null };
}

export interface Sheet {
  meta: SheetMeta;
  files: Record<string, FileSheetRow>;
  transactions: Record<string, TransactionSheetRow>;
}

export interface BuildSheetOptions {
  label: string;
  gitSha?: string | null;
  setLabel: string;
  setExportedAt: string;
  /** Files scored per matcher call. */
  batchSize?: number;
  now?: () => Date;
  log?: (line: string) => void;
}

const MANUAL_CONNECTION_TYPES = new Set(["manual", "suggestion_accepted"]);

const isoDay = (v: unknown) => toDateSafe(v)?.toISOString().slice(0, 10) ?? null;

/** The File as the matcher sees a fresh upload: its own connections set aside. */
function asFreshUpload(id: string, data: Data): MatcherFile {
  const copy: Data = { ...data };
  delete copy.transactionIds;
  delete copy.transactionSuggestions;
  return { id, data: copy };
}

export async function buildSheet(userId: string, options: BuildSheetOptions): Promise<Sheet> {
  const db = getFirestore();
  const log = options.log ?? (() => {});
  const batchSize = options.batchSize ?? 50;

  // --- Files ---------------------------------------------------------------
  const connectionsSnap = await db.collection("fileConnections").where("userId", "==", userId).get();
  const manualByFile = new Map<string, string[]>();
  const automatedByFile = new Map<string, string[]>();
  for (const doc of connectionsSnap.docs) {
    const c = doc.data();
    if (typeof c.fileId !== "string" || typeof c.transactionId !== "string") continue;
    const bucket = MANUAL_CONNECTION_TYPES.has(c.connectionType) ? manualByFile : automatedByFile;
    const list = bucket.get(c.fileId) ?? [];
    if (!list.includes(c.transactionId)) list.push(c.transactionId);
    bucket.set(c.fileId, list);
  }

  const filesSnap = await db.collection("files").where("userId", "==", userId).get();
  const fileDocs = filesSnap.docs.filter((d) => d.data().extractionComplete === true && d.data().isDeleted !== true);
  log(`files: ${filesSnap.size} stored, ${fileDocs.length} extracted and live`);

  const files: Record<string, FileSheetRow> = {};
  for (let i = 0; i < fileDocs.length; i += batchSize) {
    const batch = fileDocs.slice(i, i + batchSize);
    const matcherFiles = batch.map((d) => asFreshUpload(d.id, d.data()));
    const results = await transactionsForFiles(db, userId, matcherFiles);
    for (let j = 0; j < batch.length; j++) {
      const doc = batch[j];
      const data = doc.data();
      const result = results[j];
      const suggestions = result.ineligible ? [] : storedSuggestionsOf(result.matches);
      const picks = result.ineligible ? [] : (await selectAutoConnects(db, userId, matcherFiles[j], result)).picks;
      files[doc.id] = {
        name: typeof data.fileName === "string" ? data.fileName : doc.id,
        amount: typeof data.extractedAmount === "number" ? data.extractedAmount : null,
        date: isoDay(data.extractedDate),
        partnerId: typeof data.partnerId === "string" ? data.partnerId : null,
        ineligible: result.ineligible,
        suggestions: suggestions.map((s) => ({
          transactionId: s.transactionId,
          confidence: s.confidence,
          sources: [...(s.matchSources ?? [])],
        })),
        suggestionIds: suggestions.map((s) => s.transactionId),
        autoConnect: picks.map((p) => p.match.transactionId).sort(),
        truth: {
          manualConnections: (manualByFile.get(doc.id) ?? []).sort(),
          automatedConnections: (automatedByFile.get(doc.id) ?? []).sort(),
          rejected: [...readDismissedTransactionIds(data)].sort(),
        },
      };
    }
    log(`files scored: ${Math.min(i + batchSize, fileDocs.length)} / ${fileDocs.length}`);
  }

  // --- Transactions: Partner ------------------------------------------------
  const partnerContext = await loadPartnerMatchingContext(userId);
  const index = buildPartnerIndex(partnerContext);
  const txSnap = await db.collection("transactions").where("userId", "==", userId).get();
  log(`transactions: ${txSnap.size}`);

  const transactions: Record<string, TransactionSheetRow> = {};
  for (const doc of txSnap.docs) {
    const data = doc.data();
    const truth = {
      partnerId: typeof data.partnerId === "string" ? data.partnerId : null,
      partnerMatchedBy: typeof data.partnerMatchedBy === "string" ? data.partnerMatchedBy : null,
    };
    const base = {
      name: typeof data.name === "string" ? data.name : doc.id,
      amount: typeof data.amount === "number" ? data.amount : null,
      date: isoDay(data.date),
      truth,
    };
    if (data.noReceiptCategoryId) {
      transactions[doc.id] = { ...base, wouldAssign: null, top: null, skipped: "no-document-category" };
      continue;
    }
    if (data.quotaExceeded) {
      transactions[doc.id] = { ...base, wouldAssign: null, top: null, skipped: "over-quota" };
      continue;
    }
    const transaction: TransactionData = {
      id: doc.id,
      partner: data.partner || null,
      partnerIban: data.partnerIban || null,
      name: data.name || "",
      reference: data.reference || null,
    };
    const matches = matchTransaction(transaction, partnerContext.userPartners, partnerContext.filteredGlobalPartners).filter(
      (m) => !partnerContext.partnerManualRemovals.get(m.partnerId)?.has(doc.id)
    );
    const topMatch = matches[0] ?? null;
    let wouldAssign: string | null = null;
    if (topMatch && shouldAutoApply(topMatch.confidence)) {
      wouldAssign =
        topMatch.partnerType === "global"
          ? (index.localIdByGlobalId.get(topMatch.partnerId) ?? `global:${topMatch.partnerId}`)
          : topMatch.partnerId;
    }
    transactions[doc.id] = {
      ...base,
      wouldAssign,
      top: topMatch
        ? { partnerId: topMatch.partnerId, partnerName: topMatch.partnerName, confidence: topMatch.confidence, source: topMatch.source }
        : null,
      skipped: null,
    };
  }

  return {
    meta: {
      version: SHEET_VERSION,
      label: options.label,
      gitSha: options.gitSha ?? null,
      builtAt: (options.now ?? (() => new Date()))().toISOString(),
      userId,
      setLabel: options.setLabel,
      setExportedAt: options.setExportedAt,
    },
    files,
    transactions,
  };
}
