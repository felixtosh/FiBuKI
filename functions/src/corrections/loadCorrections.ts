/**
 * The fetch half of correction resolution (#564): the records
 * `resolveCorrections` reads, for a set of Transactions already loaded.
 *
 * Shared by the UVA period run and the BMD Export run, so the two cannot
 * resolve one refund two ways. Every record is the user's own: a File,
 * Transaction, Invoice or Category of another user is dropped as if it did
 * not exist, so a correction is never linked across users on a shared tenant.
 */

import type { CategoryRecord, FileRecord, TransactionRecord } from "../uva/adapter";
import type { EcbRateTable } from "../fx/ecbRates";
import type { UvaCorrection } from "../uva/types";
import {
  resolveCorrections,
  type CorrectionFileRecord,
  type CorrectionInvoiceRecord,
} from "./resolveCorrections";

const FETCH_CHUNK = 100;

interface InvoiceDoc extends CorrectionInvoiceRecord {
  correctedByInvoiceId?: string | null;
}

export async function loadCorrections(
  db: FirebaseFirestore.Firestore,
  userId: string,
  transactions: TransactionRecord[],
  filesById: Map<string, FileRecord>,
  categoriesById: Map<string, CategoryRecord>,
  ecbRates: EcbRateTable | null = null
): Promise<Map<string, UvaCorrection>> {
  const files = new Map<string, CorrectionFileRecord>(filesById as Map<string, CorrectionFileRecord>);
  const txById = new Map<string, TransactionRecord>();
  for (const t of transactions) txById.set(t.id, t);
  const invoices = new Map<string, InvoiceDoc>();
  const categories = new Map(categoriesById);

  const ownFiles = [...files.values()];

  // FiBuKI-issued Invoices behind these Files, and the originals they correct.
  await fetchInto(db, "invoices", userId, ownFiles.map((f) => f.invoiceId).filter(isId), invoices);
  await fetchInto(
    db,
    "invoices",
    userId,
    [...invoices.values()].map((i) => i.correctsInvoice?.invoiceId).filter(isId),
    invoices
  );

  // The originals: linked, or behind an issued correction.
  const originalIds = new Set<string>();
  for (const f of ownFiles) {
    if (f.correctionLink?.fileId) originalIds.add(f.correctionLink.fileId);
    const corrected = f.invoiceId ? invoices.get(f.invoiceId)?.correctsInvoice?.invoiceId : null;
    const originalFile = corrected ? invoices.get(corrected)?.fileId : null;
    if (originalFile) originalIds.add(originalFile);
  }
  // A File already on these lines may be an original too (D9): read the
  // other Transactions any multi-connected File sits on.
  const extraTxIds = new Set<string>();
  for (const f of ownFiles) {
    if ((f.transactionIds ?? []).length > 1) {
      for (const id of f.transactionIds ?? []) extraTxIds.add(id);
      originalIds.add(f.id);
    }
  }
  await fetchInto(db, "files", userId, [...originalIds], files);

  // Every correction File of each original, so earlier refunds through any of
  // them count against the cap: linked credit notes, and the original
  // Invoice's issued correction.
  const correctionFileIdsByOriginal = new Map<string, string[]>();
  const originals = [...originalIds].map((id) => files.get(id)).filter((f): f is CorrectionFileRecord => !!f);
  await fetchInto(db, "invoices", userId, originals.map((f) => f.invoiceId).filter(isId), invoices);
  await fetchInto(
    db,
    "invoices",
    userId,
    originals.map((f) => (f.invoiceId ? invoices.get(f.invoiceId)?.correctedByInvoiceId : null)).filter(isId),
    invoices
  );
  for (const original of originals) {
    const ids: string[] = [];
    const linked = await db
      .collection("files")
      .where("userId", "==", userId)
      .where("correctionLink.fileId", "==", original.id)
      .get();
    for (const doc of linked.docs) {
      files.set(doc.id, { ...(doc.data() as CorrectionFileRecord), id: doc.id });
      ids.push(doc.id);
    }
    const correctionInvoiceId = original.invoiceId ? invoices.get(original.invoiceId)?.correctedByInvoiceId : null;
    const issuedFileId = correctionInvoiceId ? invoices.get(correctionInvoiceId)?.fileId : null;
    if (issuedFileId) ids.push(issuedFileId);
    correctionFileIdsByOriginal.set(original.id, ids);
    for (const id of original.transactionIds ?? []) extraTxIds.add(id);
  }
  await fetchInto(db, "files", userId, [...correctionFileIdsByOriginal.values()].flat(), files);
  for (const ids of correctionFileIdsByOriginal.values()) {
    for (const id of ids) for (const t of files.get(id)?.transactionIds ?? []) extraTxIds.add(t);
  }

  for (const id of txById.keys()) extraTxIds.delete(id);
  await fetchInto(db, "transactions", userId, [...extraTxIds], txById, (data, id) => ({
    ...(data as unknown as TransactionRecord),
    id,
  }));
  await fetchInto(
    db,
    "noReceiptCategories",
    userId,
    [...txById.values()].map((t) => t.noReceiptCategoryId).filter(isId),
    categories
  );

  return resolveCorrections({
    transactions,
    filesById: files,
    transactionsById: txById,
    invoicesById: invoices,
    categoriesById: categories,
    correctionFileIdsByOriginal,
    ecbRates,
  });
}

/** Fetch the user's own documents by id into `into`, skipping ids already there. */
async function fetchInto<T extends { id: string }>(
  db: FirebaseFirestore.Firestore,
  collection: string,
  userId: string,
  ids: string[],
  into: Map<string, T>,
  shape: (data: FirebaseFirestore.DocumentData, id: string) => T = (data, id) => ({ ...data, id }) as unknown as T
): Promise<void> {
  const wanted = [...new Set(ids)].filter((id) => !into.has(id));
  for (let i = 0; i < wanted.length; i += FETCH_CHUNK) {
    const refs = wanted.slice(i, i + FETCH_CHUNK).map((id) => db.collection(collection).doc(id));
    if (refs.length === 0) continue;
    const docs = await db.getAll(...refs);
    for (const doc of docs) {
      const data = doc.data();
      if (doc.exists && data?.userId === userId) into.set(doc.id, shape(data, doc.id));
    }
  }
}

function isId(id: string | null | undefined): id is string {
  return typeof id === "string" && id.length > 0;
}
