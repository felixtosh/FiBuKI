/**
 * Invoice numbering.
 *
 * `nextInvoiceNumberSeq` is the one sequence every numbered invoice draws from:
 * a draft's pre-filled number and an Invoice Correction's own number (#133).
 *
 * `assertInvoiceNumberFree` keeps an issued number unique.
 *
 * `allocateInvoiceNumber` is the legacy atomic per-user counter, kept for
 * drafts created before numberSeq existed.
 * Stores counter at users/{userId}/settings/invoiceCounter.
 * Format: YYYY-#### (e.g., "2026-0001"). Resets on year change.
 */

import { Timestamp } from "firebase-admin/firestore";
import { HttpsError } from "../utils/createCallable";
import { toDateSafe } from "../utils/toDateSafe";

/**
 * Every write that gives an invoice its final number reads and writes this
 * document, so two of them can never commit side by side: the later one
 * conflicts, retries, and then sees the earlier one's number.
 */
function numberingLockRef(db: FirebaseFirestore.Firestore, userId: string) {
  return db.collection("users").doc(userId).collection("settings").doc("invoiceNumbering");
}

/**
 * Refuse `number` when another of the user's invoices already holds it.
 *
 * § 11 Abs 1 Z 5 UStG: an invoice number identifies one invoice. Drafts hold
 * no number yet; a cancelled invoice keeps its own on record. Call inside the
 * transaction that writes the number, before any write of that transaction.
 */
export async function assertInvoiceNumberFree(
  tx: FirebaseFirestore.Transaction,
  db: FirebaseFirestore.Firestore,
  userId: string,
  number: string,
  invoiceId: string,
): Promise<void> {
  const lockRef = numberingLockRef(db, userId);
  await tx.get(lockRef);
  const holders = await tx.get(
    db.collection("invoices").where("userId", "==", userId).where("number", "==", number),
  );
  const taken = holders.docs.some((d) => d.id !== invoiceId && d.data().status !== "draft");
  if (taken) {
    throw new HttpsError(
      "already-exists",
      `Invoice number ${number} is already used by another invoice. Choose another number.`,
    );
  }
  tx.set(lockRef, { updatedAt: Timestamp.now() }, { merge: true });
}

/**
 * (highest sequence this user holds in `year`) + 1.
 *
 * Deliberately not filtered by namePrefix (that would need an extra composite
 * index): the seq is shared across all of the user's invoices in the year,
 * drafts included. Scans ALL of the user's invoices (no date filter) and reads
 * both the structured numberSeq AND the trailing chunk of the legacy `number`
 * field. A year filter was dropping older sequences when timezone math pushed
 * issueDate across the boundary; doing it here keeps things consistent.
 */
export async function nextInvoiceNumberSeq(
  db: FirebaseFirestore.Firestore,
  userId: string,
  year: number,
): Promise<number> {
  const seqQuery = await db.collection("invoices").where("userId", "==", userId).get();
  let maxSeq = 0;
  const yearRegex = new RegExp(`-${year}-(\\d{1,6})$`);
  seqQuery.forEach((doc) => {
    const data = doc.data() as {
      numberSeq?: number;
      number?: string;
      issueDate?: { toDate: () => Date };
    };
    // Same-year guard: prefer the doc's stored issueDate year, fall back
    // to parsing the year from the number string.
    let docYear: number | null = null;
    try {
      docYear = toDateSafe(data.issueDate)?.getFullYear() ?? null;
    } catch {
      docYear = null;
    }
    if (docYear !== null && docYear !== year) return;

    if (typeof data.numberSeq === "number" && data.numberSeq > maxSeq) {
      maxSeq = data.numberSeq;
    }
    // Legacy fallback: parse "{prefix}-{year}-{NNNN}" from data.number.
    if (typeof data.number === "string") {
      const m = data.number.match(yearRegex);
      if (m) {
        const legacySeq = parseInt(m[1], 10);
        if (!Number.isNaN(legacySeq) && legacySeq > maxSeq) {
          maxSeq = legacySeq;
        }
      }
    }
  });
  return maxSeq + 1;
}

export async function allocateInvoiceNumber(
  db: FirebaseFirestore.Firestore,
  userId: string,
): Promise<string> {
  const counterRef = db
    .collection("users")
    .doc(userId)
    .collection("settings")
    .doc("invoiceCounter");

  const currentYear = new Date().getFullYear();

  const seq = await db.runTransaction(async (tx) => {
    const snap = await tx.get(counterRef);
    let next = 1;
    let year = currentYear;

    if (snap.exists) {
      const data = snap.data() as { next?: number; year?: number };
      if (data.year === currentYear && typeof data.next === "number") {
        next = data.next;
      } else {
        // New year (or never set) - reset
        next = 1;
        year = currentYear;
      }
    }

    tx.set(
      counterRef,
      {
        next: next + 1,
        year,
        updatedAt: new Date(),
      },
      { merge: true },
    );

    return next;
  });

  return `${currentYear}-${String(seq).padStart(4, "0")}`;
}
