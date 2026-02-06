"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Activity, Zap, DollarSign, Calendar, History, Server, Clock } from "lucide-react";
import { useUserUsage, formatFunctionName } from "@/hooks/use-user-usage";
import { useFunctionCalls, formatFunctionDisplayName, formatDuration } from "@/hooks/use-function-calls";
import { USER_TOKEN_RATE_PER_100K_EUR } from "@/types/billing";
import { cn } from "@/lib/utils";
import { SettingsPageHeader } from "@/components/ui/settings-page-header";

function formatTokens(tokens: number): string {
  if (tokens >= 1000000) {
    return `${(tokens / 1000000).toFixed(2)}M`;
  }
  if (tokens >= 1000) {
    return `${(tokens / 1000).toFixed(1)}K`;
  }
  return tokens.toString();
}

function formatCost(cost: number): string {
  if (cost < 0.01) {
    return `${cost.toFixed(4)} EUR`;
  }
  return `${cost.toFixed(2)} EUR`;
}

export function UserUsageDashboard() {
  const [view, setView] = useState<"current" | "history">("current");
  const {
    currentMonth,
    monthlyHistory,
    recentActivity,
    totalTokens,
    totalCost,
    loading,
    error,
  } = useUserUsage();

  const {
    summary: fnSummary,
    records: fnRecords,
    loading: fnLoading,
    error: fnError,
  } = useFunctionCalls({ dateRange: "30d" });

  if (error || fnError) {
    return (
      <div className="p-4 text-red-500">
        Error loading usage data: {(error || fnError)?.message}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header with view toggle */}
      <SettingsPageHeader
        title="AI Usage"
        description="Track your AI feature usage and estimated costs"
        className="mb-0"
      >
        <div className="flex items-center gap-2">
          <Button
            variant={view === "current" ? "default" : "outline"}
            size="sm"
            onClick={() => setView("current")}
          >
            <Calendar className="h-4 w-4 mr-1" />
            This Month
          </Button>
          <Button
            variant={view === "history" ? "default" : "outline"}
            size="sm"
            onClick={() => setView("history")}
          >
            <History className="h-4 w-4 mr-1" />
            History
          </Button>
        </div>
      </SettingsPageHeader>

      {/* Current Month View */}
      {view === "current" && (
        <>
          {/* AI Usage Summary Cards */}
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-3">AI Usage</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Tokens This Month
                  </CardTitle>
                  <Zap className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  {loading ? (
                    <Skeleton className="h-8 w-24" />
                  ) : (
                    <div className="text-2xl font-bold">
                      {formatTokens(currentMonth?.tokens || 0)}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Est. Cost This Month
                  </CardTitle>
                  <DollarSign className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  {loading ? (
                    <Skeleton className="h-8 w-24" />
                  ) : (
                    <div className="text-2xl font-bold">
                      {formatCost(currentMonth?.cost || 0)}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    AI Operations
                  </CardTitle>
                  <Activity className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  {loading ? (
                    <Skeleton className="h-8 w-16" />
                  ) : (
                    <div className="text-2xl font-bold">
                      {currentMonth?.calls || 0}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
            <p className="text-xs text-muted-foreground mt-2">
              Costs are estimated at {USER_TOKEN_RATE_PER_100K_EUR.toFixed(2)} EUR per
              100,000 tokens.
            </p>
          </div>

          {/* API Calls Summary Cards */}
          <div>
            <h3 className="text-sm font-medium text-muted-foreground mb-3">API Calls (Last 30 Days)</h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Total API Calls
                  </CardTitle>
                  <Server className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  {fnLoading ? (
                    <Skeleton className="h-8 w-24" />
                  ) : (
                    <div className="text-2xl font-bold">
                      {fnSummary.totalCalls}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Successful
                  </CardTitle>
                  <Activity className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  {fnLoading ? (
                    <Skeleton className="h-8 w-24" />
                  ) : (
                    <div className="text-2xl font-bold text-green-600">
                      {fnSummary.successCount}
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="flex flex-row items-center justify-between pb-2">
                  <CardTitle className="text-sm font-medium text-muted-foreground">
                    Avg Response Time
                  </CardTitle>
                  <Clock className="h-4 w-4 text-muted-foreground" />
                </CardHeader>
                <CardContent>
                  {fnLoading ? (
                    <Skeleton className="h-8 w-24" />
                  ) : (
                    <div className="text-2xl font-bold">
                      {fnSummary.totalCalls > 0 ? formatDuration(fnSummary.avgDurationMs) : "—"}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          </div>

          {/* Recent Activity */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Recent Activity</CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {loading ? (
                <div className="p-4 space-y-3">
                  {[...Array(5)].map((_, i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : recentActivity.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No usage yet. Start using AI features to see activity here.
                </p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Time</TableHead>
                      <TableHead>Feature</TableHead>
                      <TableHead className="text-right">Tokens</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {recentActivity.map((record) => (
                      <TableRow key={record.id}>
                        <TableCell className="text-muted-foreground">
                          {record.createdAt.toDate().toLocaleString("de-DE", {
                            day: "2-digit",
                            month: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </TableCell>
                        <TableCell>
                          {formatFunctionName(record.function)}
                        </TableCell>
                        <TableCell className="text-right font-mono text-sm">
                          {formatTokens(
                            record.inputTokens + record.outputTokens
                          )}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* History View */}
      {view === "history" && (
        <>
          {/* Total Summary */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Total Tokens (All Time)
                </CardTitle>
                <Zap className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                {loading ? (
                  <Skeleton className="h-8 w-24" />
                ) : (
                  <div className="text-2xl font-bold">
                    {formatTokens(totalTokens)}
                  </div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  Total Est. Cost (All Time)
                </CardTitle>
                <DollarSign className="h-4 w-4 text-muted-foreground" />
              </CardHeader>
              <CardContent>
                {loading ? (
                  <Skeleton className="h-8 w-24" />
                ) : (
                  <div className="text-2xl font-bold">
                    {formatCost(totalCost)}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>

          {/* Monthly History */}
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Monthly History</CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <div className="space-y-3">
                  {[...Array(3)].map((_, i) => (
                    <Skeleton key={i} className="h-16 w-full" />
                  ))}
                </div>
              ) : monthlyHistory.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">
                  No historical data yet.
                </p>
              ) : (
                <div className="space-y-3">
                  {monthlyHistory.map((month) => (
                    <div
                      key={month.month}
                      className="flex items-center justify-between p-4 border rounded-lg"
                    >
                      <div>
                        <div className="font-medium">{month.monthLabel}</div>
                        <div className="text-sm text-muted-foreground">
                          {month.calls} operations
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-medium">
                          {formatCost(month.cost)}
                        </div>
                        <div className="text-sm text-muted-foreground">
                          {formatTokens(month.tokens)} tokens
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>

          {/* Pricing Info */}
          <p className="text-xs text-muted-foreground">
            Costs are estimated at {USER_TOKEN_RATE_PER_100K_EUR.toFixed(2)} EUR per
            100,000 tokens.
          </p>
        </>
      )}
    </div>
  );
}
