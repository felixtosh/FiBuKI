/**
 * Duplicate detection for imported Transactions. Server side only, one copy.
 *
 * Every import path (the web CSV import through bulkCreateTransactions, the
 * MCP/REST import_transactions tool) computes the hash and asks the question
 * here, so the formula cannot drift between surfaces and no client has to know
 * it. The formula is the one the web import has always used, so rows already
 * stored keep matching.
 *
 * What counts as a duplicate: a row whose hash was already stored for the same
 * Bank Account by an EARLIER import. Rows of the same import (same importJobId)
 * never count against each other: two identical coffees on one day with no
 * reference are two real payments, and must survive even when they land in
 * different chunks of one file.
 */

import { createHash } from "crypto";
import type { Firestore } from "firebase-admin/firestore";

/** Firestore limits an `in` query to 30 values. */
const IN_QUERY_LIMIT = 30;

export interface DedupeHashInput {
  /** Any date string or Date; reduced to its UTC calendar day. */
  date: string | Date;
  /** Integer cents. */
  amount: number;
  /** The Bank Account's IBAN, or its id when it has none (credit cards). */
  sourceIdentifier: string;
  reference?: string | null;
}

/** The UTC calendar day (YYYY-MM-DD), as stored on every Transaction. */
export function utcDay(date: string | Date): string {
  const parsed = date instanceof Date ? date : new Date(date);
  if (isNaN(parsed.getTime())) {
    throw new Error(`Invalid date: ${String(date)}`);
  }
  return parsed.toISOString().slice(0, 10);
}

/** sha256 of `day|amount|IBAN-without-spaces-uppercased|REFERENCE-trimmed-uppercased`. */
export function computeDedupeHash({ date, amount, sourceIdentifier, reference }: DedupeHashInput): string {
  const identifier = sourceIdentifier.replace(/\s+/g, "").toUpperCase();
  const ref = (reference ?? "").trim().toUpperCase();
  return createHash("sha256").update(`${utcDay(date)}|${amount}|${identifier}|${ref}`).digest("hex");
}

/**
 * The hashes in `hashes` that an earlier import already stored for this Bank
 * Account. `currentImportJobId` excludes the rows of the import in progress.
 */
export async function findEarlierImportHashes(
  db: Firestore,
  userId: string,
  sourceId: string,
  hashes: string[],
  currentImportJobId?: string
): Promise<Set<string>> {
  const existing = new Set<string>();
  const unique = [...new Set(hashes)];

  for (let i = 0; i < unique.length; i += IN_QUERY_LIMIT) {
    const snapshot = await db
      .collection("transactions")
      .where("userId", "==", userId)
      .where("sourceId", "==", sourceId)
      .where("dedupeHash", "in", unique.slice(i, i + IN_QUERY_LIMIT))
      .get();

    for (const doc of snapshot.docs) {
      const data = doc.data();
      if (data.dedupeHash && (!currentImportJobId || data.importJobId !== currentImportJobId)) {
        existing.add(data.dedupeHash as string);
      }
    }
  }

  return existing;
}

/** Split rows into those to write and those an earlier import already holds. */
export async function splitDuplicates<T extends { dedupeHash: string }>(
  db: Firestore,
  userId: string,
  sourceId: string,
  rows: T[],
  currentImportJobId?: string
): Promise<{ fresh: T[]; duplicates: T[] }> {
  const earlier = await findEarlierImportHashes(
    db,
    userId,
    sourceId,
    rows.map((r) => r.dedupeHash),
    currentImportJobId
  );
  const fresh: T[] = [];
  const duplicates: T[] = [];
  for (const row of rows) (earlier.has(row.dedupeHash) ? duplicates : fresh).push(row);
  return { fresh, duplicates };
}
