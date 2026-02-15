"use client";

import Link from "next/link";
import { CheckCircle2, AlertCircle, AlertTriangle, ArrowRight, FileQuestion, Users, Receipt, FileX } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { cn } from "@/lib/utils";
import { ReportReadiness, ReportPeriod, formatPeriod } from "@/types/report";

interface ReportReadinessCheckProps {
  readiness: ReportReadiness;
  period: ReportPeriod;
}

export function ReportReadinessCheck({ readiness, period }: ReportReadinessCheckProps) {
  const hasNoTransactions = readiness.totalTransactions === 0;
  const isActuallyReady = readiness.isReady && !hasNoTransactions;

  const getIssueIcon = (type: string) => {
    switch (type) {
      case "missing_receipt":
        return <Receipt className="h-4 w-4" />;
      case "missing_partner":
        return <Users className="h-4 w-4" />;
      default:
        return <FileQuestion className="h-4 w-4" />;
    }
  };

  // No transactions state
  if (hasNoTransactions) {
    return (
      <Card className="border-muted bg-muted/20">
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileX className="h-5 w-5 text-muted-foreground" />
              <CardTitle className="text-base">No Transactions</CardTitle>
            </div>
            <span className="text-sm text-muted-foreground">
              {formatPeriod(period)}
            </span>
          </div>
          <CardDescription>
            No transactions found for this period. Import bank statements or check the selected date range.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-4">
            <Button variant="outline" asChild>
              <Link href="/sources">
                Import Transactions
              </Link>
            </Button>
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className={cn(
      isActuallyReady
        ? "border-green-200 bg-green-50 dark:border-green-800 dark:bg-green-950/30"
        : "border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30"
    )}>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            {isActuallyReady ? (
              <CheckCircle2 className="h-5 w-5 text-green-600 dark:text-green-400" />
            ) : (
              <AlertCircle className="h-5 w-5 text-amber-600 dark:text-amber-400" />
            )}
            <CardTitle className="text-base">
              {isActuallyReady ? "Ready to Submit" : "Action Required"}
            </CardTitle>
          </div>
          <span className="text-sm text-muted-foreground">
            {formatPeriod(period)}
          </span>
        </div>
        <CardDescription>
          {isActuallyReady
            ? "All transactions are documented and ready for reporting."
            : `${readiness.incompleteTransactions} of ${readiness.totalTransactions} transactions need attention.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Progress bar */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Completion</span>
            <span className="font-medium">{readiness.completionPercentage}%</span>
          </div>
          <Progress
            value={readiness.completionPercentage}
            className={cn(
              "h-2",
              readiness.completionPercentage === 100 && "[&>div]:bg-green-600"
            )}
          />
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>{readiness.completeTransactions} complete</span>
            <span>{readiness.incompleteTransactions} incomplete</span>
          </div>
        </div>

        {/* Blocking issues */}
        {readiness.blockingIssues.length > 0 && (
          <div className="space-y-3 pt-2 border-t">
            {readiness.blockingIssues.map((issue, index) => (
              <div
                key={index}
                className="flex items-start gap-3 p-3 bg-background rounded-lg border"
              >
                <div className="flex-shrink-0 mt-0.5 text-amber-600 dark:text-amber-400">
                  {getIssueIcon(issue.type)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{issue.message}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {issue.count} transaction{issue.count !== 1 ? "s" : ""} affected
                  </p>
                </div>
                <Button variant="ghost" size="sm" asChild>
                  <Link
                    href={`/transactions?filter=incomplete`}
                    className="flex items-center gap-1"
                  >
                    Fix
                    <ArrowRight className="h-3 w-3" />
                  </Link>
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Ready state actions */}
        {isActuallyReady && (
          <div className="pt-2 border-t">
            <p className="text-sm text-green-700 dark:text-green-400">
              All {readiness.totalTransactions} transactions have proper documentation.
              You can now export or submit your UVA report.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
