"use client";

import { useCallback, useMemo } from "react";
import {
  doc,
  type DocumentSnapshot,
  type FirestoreError,
} from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { useFirestoreDoc } from "@/lib/firebase/use-firestore-collection";
import { Invoice } from "@/types/invoice";

function mapInvoice(snap: DocumentSnapshot): Invoice | null {
  if (!snap.exists()) return null;
  return { id: snap.id, ...snap.data() } as Invoice;
}

/**
 * Realtime hook for a single invoice document.
 * Returns the invoice (or null if not found / not loaded yet) plus a loading flag.
 */
export function useInvoice(invoiceId: string | null) {
  const ref = useMemo(
    () => (invoiceId ? doc(db, "invoices", invoiceId) : null),
    [invoiceId],
  );

  const handleError = useCallback((err: FirestoreError) => {
    // Permission-denied is expected when the invoice has just been deleted
    // (e.g. abandon-cleanup on close): Firestore evaluates the owner rule
    // against a null resource and denies. Treat as not-found rather than
    // logging a scary error.
    if (err.code !== "permission-denied") {
      console.error("useInvoice snapshot error:", err);
    }
  }, []);

  const { data: invoice, loading } = useFirestoreDoc(ref, mapInvoice, handleError);

  return { invoice, loading };
}
