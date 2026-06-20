"use client";

import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { Invoice } from "@/types/invoice";

/**
 * Realtime hook for a single invoice document.
 * Returns the invoice (or null if not found / not loaded yet) plus a loading flag.
 */
export function useInvoice(invoiceId: string | null) {
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    if (!invoiceId) {
      setInvoice(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const ref = doc(db, "invoices", invoiceId);
    const unsub = onSnapshot(
      ref,
      (snap) => {
        if (snap.exists()) {
          setInvoice({ id: snap.id, ...snap.data() } as Invoice);
        } else {
          setInvoice(null);
        }
        setLoading(false);
      },
      (err) => {
        // Permission-denied is expected when the invoice has just been
        // deleted (e.g. abandon-cleanup on close): Firestore evaluates the
        // owner rule against a null resource and denies. Treat as not-found
        // rather than logging a scary error.
        const code = (err as { code?: string }).code;
        if (code !== "permission-denied") {
          console.error("useInvoice snapshot error:", err);
        }
        setInvoice(null);
        setLoading(false);
      }
    );
    return () => unsub();
  }, [invoiceId]);

  return { invoice, loading };
}
