"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { ArrowLeft, ChevronRight, ReceiptText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { TableEmptyState } from "@/components/ui/table-empty-state";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DocumentTypeBadge } from "@/components/documents/document-type-badge";
import { Section11MissingElements } from "@/components/documents/section-11-details";
import { useTransactions } from "@/hooks/use-transactions";
import { useFiles } from "@/hooks/use-files";
import { usePageTitle } from "@/hooks/use-page-title";
import { buildChaseQueue } from "@/lib/documents/chase-queue";
import { KLEINBETRAG_LIMIT_CENTS } from "@/lib/documents/document-type-presentation";
import { formatCurrency } from "@/lib/utils";

/**
 * The receipt-only chase queue (#207).
 *
 * The work list #96 asked for: the transactions where money moved, a document
 * is attached, and that document is a payment confirmation rather than a
 * Rechnung under § 11 — so no Vorsteuer may be claimed and the supplier has to
 * be asked. Those lines are green everywhere else in the app and stay green:
 * `isComplete` is untouched by design, and the gap surfaces here instead.
 *
 * Membership, the row fields and the amount filter are the same ones the
 * `list_transactions_missing_invoice` agent tool serves, taken from the same
 * pure module — the operator and the agent must never be working different
 * lists. Ordering defaults to the largest deduction, because a 4 EUR receipt
 * and a 900 EUR one cost the same mail to chase.
 *
 * Until the backfill (#204, homelab#135) has run, every transaction reads as
 * unset and this queue is honestly empty. The empty state says so rather than
 * claiming the books are clean.
 */

type SortKey = "amount" | "date";

/** The last option is § 11 Abs 6's own threshold, not a round number. */
const AMOUNT_THRESHOLDS: { value: string; label: string; cents: number | null }[] = [
  { value: "all", label: "Any amount", cents: null },
  { value: "50", label: "50 € and up", cents: 50_00 },
  { value: "100", label: "100 € and up", cents: 100_00 },
  {
    value: "kleinbetrag",
    label: "Over 400 € (§ 11 Abs 1)",
    cents: KLEINBETRAG_LIMIT_CENTS,
  },
];

export default function ChaseQueuePage() {
  usePageTitle("Chase queue");

  const { transactions, loading: transactionsLoading } = useTransactions();
  const { files, loading: filesLoading } = useFiles();

  const [sort, setSort] = useState<SortKey>("amount");
  const [threshold, setThreshold] = useState("all");

  const minAmount =
    AMOUNT_THRESHOLDS.find((t) => t.value === threshold)?.cents ?? null;

  const { rows, totalCount, totalAmount, currencies } = useMemo(
    () => buildChaseQueue(transactions, files, { minAmount, sort }),
    [transactions, files, minAmount, sort]
  );

  const loading = transactionsLoading || filesLoading;
  const hiddenByThreshold = totalCount - rows.length;

  return (
    <TooltipProvider>
      <div className="h-full overflow-auto p-6">
        <div className="max-w-4xl mx-auto space-y-6">
          {/* Header */}
          <div className="space-y-3">
            <Button variant="ghost" size="sm" className="-ml-2 h-8 gap-2" asChild>
              <Link href="/transactions">
                <ArrowLeft className="h-4 w-4" />
                Transactions
              </Link>
            </Button>
            <div>
              <h1 className="text-2xl font-bold flex items-center gap-2">
                <ReceiptText className="h-6 w-6" />
                Chase queue
              </h1>
              <p className="text-sm text-muted-foreground mt-1">
                Paid, documented by a payment confirmation only — no Rechnung under
                § 11 UStG, so no Vorsteuer. Ask the supplier for one.
              </p>
            </div>
          </div>

          {/* Controls */}
          <div className="flex flex-wrap items-center gap-3">
            <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
              <SelectTrigger className="w-[190px] h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="amount">Largest deduction first</SelectItem>
                <SelectItem value="date">Newest first</SelectItem>
              </SelectContent>
            </Select>

            <Select value={threshold} onValueChange={setThreshold}>
              <SelectTrigger className="w-[190px] h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {AMOUNT_THRESHOLDS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            {!loading && totalCount > 0 && (
              <p className="text-sm text-muted-foreground">
                {rows.length} {rows.length === 1 ? "transaction" : "transactions"}
                {/*
                  Nothing here converts, so a total is only printed when the
                  rows are all in one currency. A mixed sum labelled EUR would
                  be a made-up number.
                */}
                {currencies.length === 1 && (
                  <span> · {formatCurrency(totalAmount, currencies[0])}</span>
                )}
                {/* A threshold must never silently shrink the queue. */}
                {hiddenByThreshold > 0 && (
                  <span> · {hiddenByThreshold} below the threshold</span>
                )}
              </p>
            )}
          </div>

          {loading ? (
            <div className="space-y-3">
              {[...Array(3)].map((_, i) => (
                <Skeleton key={i} className="h-28 w-full" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <TableEmptyState
              icon={<ReceiptText className="h-full w-full" />}
              title={
                totalCount === 0
                  ? "Nothing to chase"
                  : "Nothing above this threshold"
              }
              description={
                totalCount === 0
                  ? "No transaction is documented by a payment confirmation alone. Transactions whose documents have not been classified yet do not appear here — an unchecked line is not a defect."
                  : `${totalCount} receipt-only ${totalCount === 1 ? "transaction" : "transactions"} sit below the amount you picked.`
              }
              size="sm"
            />
          ) : (
            <div className="space-y-3">
              {rows.map((row) => (
                <Card key={row.id}>
                  <CardContent className="p-4 space-y-3">
                    {/* Vendor, date, amount — what a request to the supplier needs */}
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <Link
                          href={`/transactions?id=${row.id}`}
                          className="text-sm font-medium hover:underline flex items-center gap-1"
                        >
                          <span className="truncate">{row.vendor || "Unknown vendor"}</span>
                          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        </Link>
                        <p className="text-xs text-muted-foreground truncate">
                          {row.date ? format(row.date, "d MMM yyyy") : "No date"}
                          {row.name && row.name !== row.vendor && <> · {row.name}</>}
                        </p>
                      </div>
                      <span className="text-sm font-medium tabular-nums whitespace-nowrap">
                        {formatCurrency(Math.abs(row.amount), row.currency)}
                      </span>
                    </div>

                    {/* What is attached, and what each document was classified as */}
                    <div className="space-y-1">
                      {row.documents.map((document) => (
                        <div
                          key={document.fileId}
                          className="flex items-center justify-between gap-2"
                        >
                          <Link
                            href={`/files?id=${document.fileId}`}
                            className="text-xs text-muted-foreground truncate hover:underline"
                          >
                            {document.fileName || document.fileId}
                          </Link>
                          <DocumentTypeBadge type={document.documentType} />
                        </div>
                      ))}
                    </div>

                    {/*
                      The § 11 elements the attached document is missing, named
                      by the same module the file surfaces name them with, so
                      the operator cites the same defect in both places.
                    */}
                    <Section11MissingElements
                      documentType="receipt"
                      elements={row.missingElements}
                    />
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </div>
    </TooltipProvider>
  );
}
