"use client";

/**
 * Transactions related to this one through an Invoice Correction (#564,
 * story 18): a refund leads to the payment of the original it corrects, and
 * that payment to its refunds. Renders nothing when there are none.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { FileMinus } from "lucide-react";
import { callFunction } from "@/lib/firebase/callable";
import { formatCurrency } from "@/lib/utils";
import type { CorrectionTransactionView } from "@/types/correction";

export function TransactionCorrectionRelated({
  transactionId,
  fileKey,
}: {
  transactionId: string;
  /** The Transaction's File ids, joined: a change re-reads the relation. */
  fileKey: string;
}) {
  const t = useTranslations("files.correction");
  const [view, setView] = useState(null as CorrectionTransactionView | null);

  useEffect(() => {
    let live = true;
    if (!fileKey) return;
    callFunction<{ transactionId: string }, CorrectionTransactionView>("getCorrection", { transactionId })
      .then((v) => live && setView(v))
      .catch(() => live && setView(null));
    return () => {
      live = false;
    };
  }, [transactionId, fileKey]);

  // A view of another Transaction, or of Files since taken off, is not shown.
  if (!fileKey || !view || view.transactionId !== transactionId || view.related.length === 0) return null;
  return (
    <section className="rounded-md border bg-muted/40 p-3 space-y-1" data-testid="transaction-correction-related">
      <ul className="space-y-0.5">
        {view.related.map((r) => (
          <li key={r.id} className="flex items-center gap-2 text-sm">
            <FileMinus className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <span className="text-muted-foreground shrink-0">{t(r.relation === "refund-of" ? "transactionCorrects" : "transactionCorrectedBy")}</span>
            <Link href={`/transactions?id=${r.id}`} className="truncate hover:underline">
              {[r.date, r.partner].filter(Boolean).join(" · ")}
            </Link>
            <span className="ml-auto tabular-nums">{formatCurrency(r.amount)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
