/**
 * What a File Connection teaches the Partner, and what an Unlink takes back.
 *
 * Runs after the write has committed and never fails it: the Connection is
 * already made, and a failed lesson must not be reported as a failed connect.
 */

import { FieldValue, Timestamp } from "firebase-admin/firestore";
import { learnBillingCycleForPartner } from "../matching/learnBillingCycle";
import { ORIGIN_RULES, type ConnectionOrigin } from "./rules";

type Db = FirebaseFirestore.Firestore;
type Data = FirebaseFirestore.DocumentData;

/** How the File was found, when a search found it. Stored on the record. */
export interface FileConnectionSourceInfo {
  sourceType?: string;
  searchPattern?: string;
  gmailIntegrationId?: string;
  gmailIntegrationEmail?: string;
  mailMessageId?: string;
  gmailMessageFrom?: string;
  gmailMessageFromName?: string;
  resultType?: string;
}

interface PartnerFileSourcePattern {
  sourceType: string;
  pattern: string;
  integrationId?: string | null;
  resultType?: string;
  confidence: number;
  usageCount: number;
  sourceTransactionIds?: string[];
  filenameExamples?: string[];
  createdAt?: Timestamp;
  lastUsedAt?: Timestamp;
  fromDomain?: string;
}

export interface ConnectionLesson {
  origin: ConnectionOrigin;
  partnerId: string | null;
  transactionId: string;
  fileData: Data;
  sourceInfo?: FileConnectionSourceInfo;
}

export async function learnFromConnection(db: Db, userId: string, lesson: ConnectionLesson): Promise<void> {
  const { partnerId } = lesson;
  if (!partnerId) return;
  const directed = ORIGIN_RULES[lesson.origin].learning === "directed";
  try {
    await learnOnPartner(db, userId, partnerId, lesson, directed);
  } catch (err) {
    console.error(`[fileConnections] Failed to learn from connection on partner ${partnerId}:`, err);
  }
  // yazzbert/FiBuKI-selfhost#166: the document just attached carries the
  // invoice date the invoice-to-transaction delay is derived from, so the one
  // Partner is learned again, history only, no AI call.
  if (directed) {
    try {
      await learnBillingCycleForPartner(db, userId, partnerId);
    } catch (err) {
      console.error(`[fileConnections] Failed to learn billing cycle for ${partnerId}:`, err);
    }
  }
}

async function learnOnPartner(
  db: Db,
  userId: string,
  partnerId: string,
  lesson: ConnectionLesson,
  directed: boolean
): Promise<void> {
  const { sourceInfo, fileData, transactionId } = lesson;
  const senderDomain =
    (directed && sourceInfo?.gmailMessageFrom ? extractEmailDomain(sourceInfo.gmailMessageFrom) : null) ??
    (typeof fileData.gmailSenderDomain === "string" && fileData.gmailSenderDomain.trim()
      ? fileData.gmailSenderDomain.toLowerCase().trim()
      : null);
  const searchPattern = directed ? sourceInfo?.searchPattern?.trim() : undefined;
  if (!senderDomain && !searchPattern) return;

  const partnerRef = db.collection("partners").doc(partnerId);
  const partnerSnap = await partnerRef.get();
  if (!partnerSnap.exists || partnerSnap.data()?.userId !== userId) return;
  const partnerData = partnerSnap.data()!;

  const now = Timestamp.now();
  const updates: Record<string, unknown> = { updatedAt: now };
  let changed = false;

  const existingDomains: string[] = partnerData.emailDomains || [];
  if (senderDomain && !existingDomains.includes(senderDomain)) {
    updates.emailDomains = FieldValue.arrayUnion(senderDomain);
    updates.emailDomainsUpdatedAt = now;
    changed = true;
  }

  if (directed) {
    const patterns = [...((partnerData.fileSourcePatterns || []) as PartnerFileSourcePattern[])];
    const filenameExample = typeof fileData.fileName === "string" ? fileData.fileName : undefined;
    const integrationId = sourceInfo?.gmailIntegrationId || null;
    let patternsChanged = false;

    // Gmail sender domain as a search pattern, only when the connect says the
    // File came from that sender.
    const fromDomain = sourceInfo?.gmailMessageFrom ? extractEmailDomain(sourceInfo.gmailMessageFrom) : null;
    if (fromDomain) {
      patternsChanged =
        upsertPattern(
          patterns,
          {
            sourceType: "gmail",
            pattern: `from:${fromDomain}`,
            integrationId,
            resultType: "gmail_attachment",
            confidence: 80,
            usageCount: 1,
            fromDomain,
          },
          transactionId,
          filenameExample,
          (p) =>
            (p.sourceType || "").toLowerCase() === "gmail" &&
            (p.integrationId || null) === integrationId &&
            ((p.pattern || "").toLowerCase() === `from:${fromDomain}` || p.fromDomain === fromDomain)
        ) || patternsChanged;
    }

    // The search query that found the File.
    if (searchPattern) {
      const sourceType = sourceInfo?.sourceType || "gmail";
      const resultType = sourceInfo?.resultType || "gmail_attachment";
      patternsChanged =
        upsertPattern(
          patterns,
          { sourceType, pattern: searchPattern, integrationId, resultType, confidence: 85, usageCount: 1 },
          transactionId,
          filenameExample,
          (p) =>
            (p.sourceType || "").toLowerCase() === sourceType.toLowerCase() &&
            (p.pattern || "").toLowerCase() === searchPattern.toLowerCase() &&
            (p.integrationId || null) === integrationId &&
            (p.resultType || null) === (resultType || null)
        ) || patternsChanged;
    }

    if (patternsChanged) {
      updates.fileSourcePatterns = patterns;
      updates.fileSourcePatternsUpdatedAt = now;
      changed = true;
    }
  }

  if (changed) await partnerRef.update(updates);
}

/**
 * A removed File Connection that a search found counts one use less on the
 * Partner's learned file source pattern; a pattern with no use left goes.
 */
export async function unlearnFileSourcePattern(
  db: Db,
  userId: string,
  partnerId: string,
  transactionId: string,
  connection: Data
): Promise<void> {
  const sourceType = connection.sourceType as string | undefined;
  const searchPattern = connection.searchPattern as string | undefined;
  if (!sourceType || !searchPattern) return;

  const partnerRef = db.collection("partners").doc(partnerId);
  const partnerSnap = await partnerRef.get();
  if (!partnerSnap.exists || partnerSnap.data()?.userId !== userId) return;

  const patterns = (partnerSnap.data()!.fileSourcePatterns || []) as PartnerFileSourcePattern[];
  const index = patterns.findIndex((p) => {
    if (p.sourceType !== sourceType) return false;
    if ((p.pattern || "").toLowerCase() !== searchPattern.toLowerCase()) return false;
    if (sourceType === "gmail" && (p.integrationId ?? null) !== (connection.gmailIntegrationId ?? null)) {
      return false;
    }
    if (connection.resultType && p.resultType && p.resultType !== connection.resultType) return false;
    return true;
  });
  if (index < 0) return;

  const now = Timestamp.now();
  const target = patterns[index];
  const remainingTxIds = (target.sourceTransactionIds || []).filter((id) => id !== transactionId);
  const nextUsageCount = Math.max(0, target.usageCount - 1);
  const next =
    nextUsageCount === 0 || remainingTxIds.length === 0
      ? patterns.filter((_, i) => i !== index)
      : patterns.map((p, i) =>
          i !== index
            ? p
            : {
                ...p,
                usageCount: nextUsageCount,
                confidence: Math.max(50, p.confidence - 5),
                sourceTransactionIds: remainingTxIds.slice(-20),
                lastUsedAt: now,
              }
        );

  await partnerRef.update({
    fileSourcePatterns: next,
    fileSourcePatternsUpdatedAt: now,
    updatedAt: now,
  });
}

function extractEmailDomain(email: string): string | null {
  if (!email) return null;
  const match = email.toLowerCase().match(/@([a-z0-9.-]+\.[a-z]{2,})/i);
  return match ? match[1] : null;
}

function upsertPattern(
  patterns: PartnerFileSourcePattern[],
  incoming: PartnerFileSourcePattern,
  transactionId: string,
  filenameExample: string | undefined,
  matcher: (pattern: PartnerFileSourcePattern) => boolean
): boolean {
  const now = Timestamp.now();
  const index = patterns.findIndex(matcher);

  if (index >= 0) {
    const current = patterns[index];
    patterns[index] = {
      ...current,
      sourceType: incoming.sourceType || current.sourceType,
      pattern: incoming.pattern || current.pattern,
      integrationId: incoming.integrationId ?? current.integrationId ?? null,
      resultType: incoming.resultType || current.resultType,
      confidence: Math.max(current.confidence || 0, incoming.confidence || 0),
      usageCount: (current.usageCount || 0) + 1,
      sourceTransactionIds: appendUnique(current.sourceTransactionIds || [], transactionId, 20),
      filenameExamples: filenameExample
        ? appendUnique(current.filenameExamples || [], filenameExample, 10)
        : current.filenameExamples || [],
      createdAt: current.createdAt || now,
      lastUsedAt: now,
      fromDomain: incoming.fromDomain || current.fromDomain,
    };
    return true;
  }

  patterns.push({
    ...incoming,
    usageCount: 1,
    sourceTransactionIds: [transactionId],
    filenameExamples: filenameExample ? [filenameExample] : [],
    createdAt: now,
    lastUsedAt: now,
  });
  return true;
}

function appendUnique(existing: string[], next: string, maxItems: number): string[] {
  const merged = [...existing.filter(Boolean)];
  if (!merged.includes(next)) merged.push(next);
  return merged.slice(-maxItems);
}
