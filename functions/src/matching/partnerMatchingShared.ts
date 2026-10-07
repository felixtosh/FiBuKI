import { FieldValue, Timestamp, getFirestore } from "firebase-admin/firestore";
import {
  matchTransaction,
  shouldAutoApply,
  PartnerData,
  TransactionData,
} from "../utils/partner-matcher";
import { createLocalPartnerFromGlobal } from "./createLocalPartnerFromGlobal";
import { CLEAR_TX_PROVENANCE } from "./partnerProvenance";
import { activityEntry } from "../utils/activity";

const db = getFirestore();
const MAX_BATCH_SIZE = 500;

interface StoredPartnerSuggestion {
  partnerId: string;
  partnerType: "global" | "user";
  confidence: number;
  source: string;
}

interface MatchableTransactionDoc {
  id: string;
  ref: FirebaseFirestore.DocumentReference;
  exists?: boolean;
  data: () => FirebaseFirestore.DocumentData | undefined;
}

export interface PartnerMatchingContext {
  userPartners: PartnerData[];
  filteredGlobalPartners: PartnerData[];
  partnerManualRemovals: Map<string, Set<string>>;
  partnerNameMap: Map<string, string>;
}

export interface NoAutoMatchTransaction {
  id: string;
  data: TransactionData;
  topConfidence: number;
}

export interface PartnerMatchWriteOperation {
  ref: FirebaseFirestore.DocumentReference;
  updates: Record<string, unknown>;
}

export interface ProcessPartnerMatchesOptions {
  userId: string;
  transactions: MatchableTransactionDoc[];
  partnerContext: PartnerMatchingContext;
  skipUnchangedSuggestions?: boolean;
  collectAgenticFallback?: boolean;
}

export interface ProcessPartnerMatchesResult {
  processed: number;
  autoMatched: number;
  withSuggestions: number;
  processedTransactionIds: string[];
  autoMatchedPartnerIds: Set<string>;
  noAutoMatchTransactions: NoAutoMatchTransaction[];
  writeOperations: PartnerMatchWriteOperation[];
}

function normalizeSuggestions(raw: unknown): StoredPartnerSuggestion[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .map((item) => {
      if (!item || typeof item !== "object") return null;

      const candidate = item as {
        partnerId?: unknown;
        partnerType?: unknown;
        confidence?: unknown;
        source?: unknown;
      };

      if (typeof candidate.partnerId !== "string") return null;
      if (candidate.partnerType !== "global" && candidate.partnerType !== "user") return null;
      if (typeof candidate.confidence !== "number" || !Number.isFinite(candidate.confidence)) return null;
      if (typeof candidate.source !== "string") return null;

      return {
        partnerId: candidate.partnerId,
        partnerType: candidate.partnerType,
        confidence: candidate.confidence,
        source: candidate.source,
      };
    })
    .filter((item): item is StoredPartnerSuggestion => item !== null);
}

function suggestionsAreEqual(
  existing: StoredPartnerSuggestion[],
  next: StoredPartnerSuggestion[]
): boolean {
  if (existing.length !== next.length) return false;

  for (let i = 0; i < existing.length; i++) {
    if (existing[i].partnerId !== next[i].partnerId) return false;
    if (existing[i].partnerType !== next[i].partnerType) return false;
    if (existing[i].confidence !== next[i].confidence) return false;
    if (existing[i].source !== next[i].source) return false;
  }

  return true;
}

export async function loadPartnerMatchingContext(
  userId: string
): Promise<PartnerMatchingContext> {
  const [userPartnersSnapshot, globalPartnersSnapshot] = await Promise.all([
    db
      .collection("partners")
      .where("userId", "==", userId)
      .where("isActive", "==", true)
      .get(),
    db.collection("globalPartners").where("isActive", "==", true).get(),
  ]);

  const partnerManualRemovals = new Map<string, Set<string>>();

  const userPartners: PartnerData[] = userPartnersSnapshot.docs.map((doc) => {
    const data = doc.data();

    const removals = data.manualRemovals || [];
    if (removals.length > 0) {
      partnerManualRemovals.set(
        doc.id,
        new Set(removals.map((r: { transactionId: string }) => r.transactionId))
      );
    }

    return {
      id: doc.id,
      name: data.name,
      aliases: data.aliases || [],
      ibans: data.ibans || [],
      website: data.website,
      vatId: data.vatId,
      learnedPatterns: data.learnedPatterns || [],
      globalPartnerId: data.globalPartnerId || null,
    };
  });

  const globalPartners: PartnerData[] = globalPartnersSnapshot.docs.map((doc) => {
    const data = doc.data();
    return {
      id: doc.id,
      name: data.name,
      aliases: data.aliases || [],
      ibans: data.ibans || [],
      website: data.website,
      vatId: data.vatId,
      patterns: data.patterns || [],
    };
  });

  const localizedGlobalIds = new Set(
    userPartners
      .map((partner) => partner.globalPartnerId)
      .filter(Boolean) as string[]
  );
  const filteredGlobalPartners = globalPartners.filter(
    (partner) => !localizedGlobalIds.has(partner.id)
  );

  const partnerNameMap = new Map<string, string>();
  for (const p of userPartners) {
    partnerNameMap.set(p.id, p.name);
  }
  for (const p of filteredGlobalPartners) {
    partnerNameMap.set(p.id, p.name);
  }

  return {
    userPartners,
    filteredGlobalPartners,
    partnerManualRemovals,
    partnerNameMap,
  };
}

export async function processPartnerMatchesForTransactions(
  options: ProcessPartnerMatchesOptions
): Promise<ProcessPartnerMatchesResult> {
  const {
    userId,
    transactions,
    partnerContext,
    skipUnchangedSuggestions = false,
    collectAgenticFallback = false,
  } = options;

  let processed = 0;
  let autoMatched = 0;
  let withSuggestions = 0;
  const processedTransactionIds: string[] = [];
  const autoMatchedPartnerIds = new Set<string>();
  const noAutoMatchTransactions: NoAutoMatchTransaction[] = [];
  const writeOperations: PartnerMatchWriteOperation[] = [];

  for (const txDoc of transactions) {
    if (txDoc.exists === false) continue;

    const txData = txDoc.data();
    if (!txData) continue;

    if (txData.partnerId) {
      continue;
    }
    if (txData.noReceiptCategoryId) {
      continue;
    }
    if (txData.quotaExceeded) {
      continue;
    }

    const transaction: TransactionData = {
      id: txDoc.id,
      partner: txData.partner || null,
      partnerIban: txData.partnerIban || null,
      name: txData.name || "",
      reference: txData.reference || null,
    };

    const matches = matchTransaction(
      transaction,
      partnerContext.userPartners,
      partnerContext.filteredGlobalPartners
    );
    processed++;

    if (matches.length === 0) {
      continue;
    }

    const filteredMatches = matches.filter((m) => {
      const removals = partnerContext.partnerManualRemovals.get(m.partnerId);
      if (removals && removals.has(txDoc.id)) {
        console.log(`  -> Skipping partner ${m.partnerId} - tx ${txDoc.id} was manually removed`);
        return false;
      }
      return true;
    });

    if (filteredMatches.length === 0) {
      continue;
    }

    const topMatch = filteredMatches[0];
    const nextSuggestions: StoredPartnerSuggestion[] = filteredMatches.map((m) => ({
      partnerId: m.partnerId,
      partnerType: m.partnerType,
      confidence: m.confidence,
      source: m.source,
    }));
    const existingSuggestions = normalizeSuggestions(txData.partnerSuggestions);
    const suggestionsChanged = !suggestionsAreEqual(existingSuggestions, nextSuggestions);
    const updates: Record<string, unknown> = {
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (shouldAutoApply(topMatch.confidence)) {
      updates.partnerSuggestions = nextSuggestions;
      let assignedPartnerId = topMatch.partnerId;
      let assignedPartnerType = topMatch.partnerType;

      if (topMatch.partnerType === "global") {
        try {
          assignedPartnerId = await createLocalPartnerFromGlobal(userId, topMatch.partnerId);
          assignedPartnerType = "user";
        } catch (error) {
          console.error(
            `[PartnerMatch] Failed to create local partner from global:`,
            error
          );
        }
      }

      updates.partnerId = assignedPartnerId;
      updates.partnerType = assignedPartnerType;
      updates.partnerMatchConfidence = topMatch.confidence;
      updates.partnerMatchedBy = "auto";
      Object.assign(updates, CLEAR_TX_PROVENANCE);
      autoMatched++;

      const partnerName = partnerContext.partnerNameMap.get(assignedPartnerId) ||
        partnerContext.partnerNameMap.get(topMatch.partnerId) ||
        null;
      updates.automationHistory = FieldValue.arrayUnion({
        type: "partner_assigned",
        ranAt: Timestamp.now(),
        status: "completed",
        actor: "auto",
        level: "outcome",
        forPartnerId: assignedPartnerId,
        partnerName,
        confidence: topMatch.confidence,
        summary: `Partner "${partnerName || assignedPartnerId}" auto-assigned`,
      });

      if (assignedPartnerType === "user") {
        autoMatchedPartnerIds.add(assignedPartnerId);
      }
    } else {
      if (skipUnchangedSuggestions && !suggestionsChanged) {
        continue;
      }

      updates.partnerSuggestions = nextSuggestions;
      withSuggestions++;

      // The log (#752): only a new best suggestion, not every re-run.
      const previousTop = Array.isArray(txData.partnerSuggestions) ? txData.partnerSuggestions[0]?.partnerId : undefined;
      if (topMatch.partnerId !== previousTop) {
        const suggestedName = partnerContext.partnerNameMap.get(topMatch.partnerId) || null;
        updates.automationHistory = FieldValue.arrayUnion(activityEntry({
          type: "partner_suggested",
          actor: "auto",
          forPartnerId: topMatch.partnerId,
          partnerName: suggestedName,
          confidence: topMatch.confidence,
          summary: `Partner "${suggestedName || topMatch.partnerId}" suggested (${Math.round(topMatch.confidence)}%)`,
        }));
      }

      if (collectAgenticFallback) {
        noAutoMatchTransactions.push({
          id: txDoc.id,
          data: transaction,
          topConfidence: topMatch.confidence,
        });
      }
    }

    writeOperations.push({
      ref: txDoc.ref,
      updates,
    });
    processedTransactionIds.push(txDoc.id);
  }

  return {
    processed,
    autoMatched,
    withSuggestions,
    processedTransactionIds,
    autoMatchedPartnerIds,
    noAutoMatchTransactions,
    writeOperations,
  };
}

/**
 * Who the applied writes were for, so their Partners' Files can be re-scored
 * (#139). The assigned Partners are read off the writes themselves;
 * `extraPartnerIds` carries the ones the writes cannot name — the previous
 * Partner of a reassign or clear.
 */
export interface PartnerFileRescoreContext {
  userId: string;
  extraPartnerIds?: Iterable<string>;
}

export async function applyPartnerMatchUpdates(
  writeOperations: PartnerMatchWriteOperation[],
  rescore?: PartnerFileRescoreContext
): Promise<void> {
  if (writeOperations.length === 0) {
    return;
  }

  let batch = db.batch();
  let batchCount = 0;

  for (const operation of writeOperations) {
    batch.update(operation.ref, operation.updates);
    batchCount++;

    if (batchCount >= MAX_BATCH_SIZE) {
      await batch.commit();
      batch = db.batch();
      batchCount = 0;
    }
  }

  if (batchCount > 0) {
    await batch.commit();
  }

  if (!rescore) return;

  // #139: a Transaction's Partner just changed, so the stored
  // `transactionSuggestions` of that Partner's unconnected Files are stale —
  // the pair now scores partner points the snapshot never saw. Once per
  // affected Partner, suggestions only, never auto-connect. Derived data, so
  // a failure here never fails the assignments that already committed.
  const affectedPartnerIds = new Set<string>();
  for (const operation of writeOperations) {
    const partnerId = operation.updates.partnerId;
    if (typeof partnerId === "string" && partnerId) {
      affectedPartnerIds.add(partnerId);
    }
  }
  for (const partnerId of rescore.extraPartnerIds ?? []) {
    if (partnerId) affectedPartnerIds.add(partnerId);
  }
  if (affectedPartnerIds.size === 0) return;

  try {
    const { rescoreUnconnectedFilesForPartners } = await import("./rescorePartnerFiles");
    await rescoreUnconnectedFilesForPartners(db, rescore.userId, affectedPartnerIds);
  } catch (error) {
    console.error(
      "[PartnerMatch] File re-score after partner updates failed (assignments are applied):",
      error
    );
  }
}

export async function queuePartnerMatchingWorker(
  userId: string,
  initialPrompt: string,
  triggerContext: Record<string, unknown>
): Promise<string> {
  const requestRef = db.collection(`users/${userId}/workerRequests`).doc();
  await requestRef.set({
    id: requestRef.id,
    workerType: "partner_matching",
    initialPrompt,
    triggerContext,
    triggeredBy: "auto",
    status: "pending",
    createdAt: Timestamp.now(),
  });
  return requestRef.id;
}
