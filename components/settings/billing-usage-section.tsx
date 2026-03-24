"use client";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Zap, Receipt, AlertTriangle, PauseCircle } from "lucide-react";
import { useSubscription } from "@/hooks/use-subscription";
import { cn } from "@/lib/utils";

function getUsageColor(percent: number): string {
  if (percent >= 90) return "text-red-600";
  if (percent >= 70) return "text-yellow-600";
  return "text-green-600";
}

function getProgressColor(percent: number): string {
  if (percent >= 90) return "[&>div]:bg-red-500";
  if (percent >= 70) return "[&>div]:bg-yellow-500";
  return "[&>div]:bg-green-500";
}

export function BillingUsageSection() {
  const {
    aiUsage,
    aiLimit,
    aiCredits,
    aiOverageCap,
    aiOverageUsed,
    aiPaused,
    aiUsagePercent,
    txCount,
    txLimit,
    txUsagePercent,
  } = useSubscription();

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {/* AI Budget */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <div className="flex items-center gap-2">
            <Zap className="h-4 w-4" />
            <CardTitle className="text-base">AI Budget</CardTitle>
          </div>
          {aiPaused && (
            <Badge variant="destructive" className="flex items-center gap-1">
              <PauseCircle className="h-3 w-3" />
              Paused
            </Badge>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Fair Use</span>
            <span className={cn("font-medium", getUsageColor(aiUsagePercent))}>
              {aiUsage.toFixed(2)} / {aiLimit.toFixed(2)} EUR
            </span>
          </div>
          <Progress
            value={aiUsagePercent}
            className={cn("h-2", getProgressColor(aiUsagePercent))}
          />

          {aiCredits > 0 && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Prepaid Credits</span>
              <span className="font-medium">{aiCredits.toFixed(2)} EUR</span>
            </div>
          )}

          {aiOverageCap > 0 && (
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Overage</span>
              <span className="font-medium">
                {aiOverageUsed.toFixed(2)} / {aiOverageCap.toFixed(2)} EUR
              </span>
            </div>
          )}

          {aiPaused && (
            <p className="text-xs text-destructive flex items-center gap-1">
              <AlertTriangle className="h-3 w-3" />
              AI matching is paused. Add credits or increase your overage cap to resume.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Transaction Quota */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between pb-3">
          <div className="flex items-center gap-2">
            <Receipt className="h-4 w-4" />
            <CardTitle className="text-base">Transactions This Month</CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Usage</span>
            <span className={cn("font-medium", getUsageColor(txUsagePercent))}>
              {txCount.toLocaleString()} / {txLimit.toLocaleString()}
            </span>
          </div>
          <Progress
            value={txUsagePercent}
            className={cn("h-2", getProgressColor(txUsagePercent))}
          />
        </CardContent>
      </Card>
    </div>
  );
}
