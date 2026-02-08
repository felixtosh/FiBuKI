"use client";

import React from "react";
import { Progress } from "@/components/ui/progress";
import { CheckCircle2, XCircle, AlertCircle, Loader2, Lock, Wallet } from "lucide-react";
import { cn, formatCurrency } from "@/lib/utils";
import Link from "next/link";

interface ImportProgressProps {
  progress: number;
  results: {
    total: number;
    imported: number;
    skipped: number;
    errors: number;
    errorDetails: { row: number; message: string; rowData: Record<string, string> }[];
    overLimitCount?: number;
    balanceDetected?: {
      openingBalance: number;
      openingBalanceDate: string;
      latestBalance: number;
      latestBalanceDate: string;
    };
  } | null;
  isComplete: boolean;
  currency?: string;
}

export function ImportProgress({
  progress,
  results,
  isComplete,
  currency = "EUR",
}: ImportProgressProps) {
  return (
    <div className="space-y-6">
      {/* Progress bar */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-sm">
          <span className="font-medium">
            {isComplete ? "Import Complete" : "Importing transactions..."}
          </span>
          <span className="text-muted-foreground">{progress}%</span>
        </div>
        <Progress value={progress} className="h-2" />
      </div>

      {/* Status */}
      {!isComplete && (
        <div className="flex items-center gap-2 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span className="text-sm">Processing rows...</span>
        </div>
      )}

      {/* Results */}
      {isComplete && results && (
        <div className="grid grid-cols-2 gap-4">
          {[
            { icon: CheckCircle2, iconColor: "text-green-600", bgColor: "bg-green-50 dark:bg-green-950/30", label: "Imported", value: results.imported, total: results.total },
            { icon: AlertCircle, iconColor: "text-yellow-600", bgColor: "bg-yellow-50 dark:bg-yellow-950/30", label: "Skipped (duplicates)", value: results.skipped, total: results.total },
            { icon: XCircle, iconColor: "text-destructive", bgColor: "bg-destructive/10", label: "Errors", value: results.errors, total: results.total },
            { icon: CheckCircle2, iconColor: "text-muted-foreground", bgColor: "bg-muted", label: "Total processed", value: results.total, total: undefined },
          ].map((card, index) => (
            <div
              key={card.label}
              className="animate-stagger-in"
              style={{ "--stagger-index": index } as React.CSSProperties}
            >
              <ResultCard {...card} />
            </div>
          ))}
        </div>
      )}

      {/* Over-limit notice */}
      {isComplete && results && (results.overLimitCount ?? 0) > 0 && (
        <div className="flex items-start gap-3 p-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800">
          <Lock className="h-5 w-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-amber-800 dark:text-amber-200">
              {results.overLimitCount} transaction{results.overLimitCount !== 1 ? "s" : ""} imported over your plan limit
            </p>
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
              These transactions are visible but auto-matching is disabled.{" "}
              <Link href="/settings/billing" className="underline underline-offset-2 font-medium hover:text-amber-700 dark:hover:text-amber-300">
                Upgrade to unlock &rarr;
              </Link>
            </p>
          </div>
        </div>
      )}

      {/* Balance detected notice */}
      {isComplete && results?.balanceDetected && (
        <div className="flex items-start gap-3 p-3 rounded-lg bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800">
          <Wallet className="h-5 w-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-blue-800 dark:text-blue-200">
              Opening balance detected from CSV
            </p>
            <p className="text-xs text-blue-600 dark:text-blue-400 mt-0.5">
              {formatCurrency(results.balanceDetected.openingBalance, currency)} as of{" "}
              {new Date(results.balanceDetected.openingBalanceDate).toLocaleDateString("de-DE")}
            </p>
          </div>
        </div>
      )}

      {/* Error details */}
      {isComplete && results && results.errorDetails.length > 0 && (
        <ErrorDetailsTable errors={results.errorDetails} />
      )}
    </div>
  );
}

interface ResultCardProps {
  icon: React.ComponentType<{ className?: string }>;
  iconColor: string;
  bgColor: string;
  label: string;
  value: number;
  total?: number;
}

function ResultCard({
  icon: Icon,
  iconColor,
  bgColor,
  label,
  value,
  total,
}: ResultCardProps) {
  return (
    <div className={cn("rounded-lg p-4", bgColor)}>
      <div className="flex items-center gap-3">
        <Icon className={cn("h-5 w-5", iconColor)} />
        <div>
          <p className="text-2xl font-bold">{value}</p>
          <p className="text-sm text-muted-foreground">
            {label}
            {total !== undefined && ` (${Math.round((value / total) * 100)}%)`}
          </p>
        </div>
      </div>
    </div>
  );
}

interface ErrorDetailsTableProps {
  errors: { row: number; message: string; rowData: Record<string, string> }[];
}

function ErrorDetailsTable({ errors }: ErrorDetailsTableProps) {
  // Get all unique column names from error rows
  const columns = errors.length > 0
    ? Object.keys(errors[0].rowData)
    : [];

  return (
    <div className="mt-6 border rounded-lg overflow-hidden">
      <div className="bg-destructive/10 px-4 py-2 border-b flex items-center gap-2">
        <XCircle className="h-4 w-4 text-destructive" />
        <span className="font-medium text-sm">
          {errors.length} Error{errors.length !== 1 ? "s" : ""}
        </span>
      </div>
      <div className="max-h-[300px] overflow-auto">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 sticky top-0">
            <tr>
              <th className="text-left px-3 py-2 font-medium whitespace-nowrap">Row</th>
              <th className="text-left px-3 py-2 font-medium whitespace-nowrap">Error</th>
              {columns.map((col) => (
                <th key={col} className="text-left px-3 py-2 font-medium whitespace-nowrap max-w-[150px] truncate">
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {errors.map((error, idx) => (
              <tr key={idx} className="border-t hover:bg-muted/30">
                <td className="px-3 py-2 text-muted-foreground">{error.row}</td>
                <td className="px-3 py-2 text-destructive whitespace-nowrap">{error.message}</td>
                {columns.map((col) => (
                  <td key={col} className="px-3 py-2 max-w-[150px] truncate" title={error.rowData[col] || ""}>
                    {error.rowData[col] || "-"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
