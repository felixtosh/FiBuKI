"use client";

import { useState, useEffect, useMemo } from "react";
import { format } from "date-fns";
import { de } from "date-fns/locale";
import {
  FileText,
  ChevronLeft,
  ChevronRight,
  AlertCircle,
  Download,
  ExternalLink,
  Clock,
  Loader2,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useUserData } from "@/hooks/use-user-data";
import { useAuth } from "@/components/auth";
import Link from "next/link";
import { db } from "@/lib/firebase/config";
import { callFunction } from "@/lib/firebase/callable";
import { formatCurrency } from "@/lib/utils";
import {
  getReportReadiness,
  calculateUVAReport,
} from "@/lib/operations";
import { OperationsContext } from "@/lib/operations/types";
import {
  ReportPeriod,
  ReportReadiness,
  UVAReport,
  formatPeriod,
  getCurrentPeriod,
  getUvaDeadline,
  isDeadlinePassed,
} from "@/types/report";
import { TaxCountryCode } from "@/types/user-data";
import { ReportReadinessCheck } from "@/components/reports/readiness-check";
import { UVAPreview } from "@/components/reports/uva-preview";
import { PeriodTimeline } from "@/components/reports/period-timeline";
import { usePageTitle } from "@/hooks/use-page-title";

const TAX_COUNTRIES: { value: TaxCountryCode; label: string; flag: string }[] = [
  { value: "AT", label: "Austria", flag: "🇦🇹" },
  { value: "DE", label: "Germany", flag: "🇩🇪" },
  { value: "CH", label: "Switzerland", flag: "🇨🇭" },
];

const MONTHS = [
  { value: 1, label: "January" },
  { value: 2, label: "February" },
  { value: 3, label: "March" },
  { value: 4, label: "April" },
  { value: 5, label: "May" },
  { value: 6, label: "June" },
  { value: 7, label: "July" },
  { value: 8, label: "August" },
  { value: 9, label: "September" },
  { value: 10, label: "October" },
  { value: 11, label: "November" },
  { value: 12, label: "December" },
];

const QUARTERS = [
  { value: 1, label: "Q1 (Jan-Mar)" },
  { value: 2, label: "Q2 (Apr-Jun)" },
  { value: 3, label: "Q3 (Jul-Sep)" },
  { value: 4, label: "Q4 (Oct-Dec)" },
];

// Generate years from 2020 to current year
function getAvailableYears(): number[] {
  const currentYear = new Date().getFullYear();
  const years: number[] = [];
  for (let y = currentYear; y >= 2020; y--) {
    years.push(y);
  }
  return years;
}

export default function ReportsPage() {
  const { userId, user, isAdmin } = useAuth();
  const { userData, loading: userDataLoading } = useUserData();

  // Set page title
  usePageTitle("Reports");

  // Period state
  const [periodType, setPeriodType] = useState<"monthly" | "quarterly">("monthly");
  const [selectedPeriod, setSelectedPeriod] = useState<ReportPeriod>(() =>
    getCurrentPeriod("monthly")
  );

  // Report state
  const [readiness, setReadiness] = useState<ReportReadiness | null>(null);
  const [report, setReport] = useState<Omit<UVAReport, "id" | "createdAt" | "updatedAt"> | null>(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState<"pdf" | "xml" | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitResult, setSubmitResult] = useState<{ success: boolean; message: string } | null>(null);

  // Account balances state
  interface AccountBalance {
    sourceId: string;
    sourceName: string;
    currency: string;
    accountKind: string;
    openingBalance: number;
    transactionSum: number;
    balanceAtDate: number;
  }
  const [accountBalances, setAccountBalances] = useState<AccountBalance[] | null>(null);
  const [balancesLoading, setBalancesLoading] = useState(false);
  const [balancesDate, setBalancesDate] = useState<string>("");

  // Operations context
  const ctx: OperationsContext = useMemo(
    () => ({
      db,
      userId: userId ?? "",
    }),
    [userId]
  );

  // Country from user settings
  const country = userData?.country || "AT";
  const countryInfo = TAX_COUNTRIES.find((c) => c.value === country);

  // Load report data when period changes
  useEffect(() => {
    if (!userId) return;

    const loadData = async () => {
      setLoading(true);
      try {
        // Load readiness check and calculate report in parallel
        const [readinessResult, reportData] = await Promise.all([
          getReportReadiness(ctx, selectedPeriod),
          calculateUVAReport(ctx, selectedPeriod, country),
        ]);
        setReadiness(readinessResult);
        setReport(reportData);
      } catch (error) {
        console.error("Error loading report data:", error);
      } finally {
        setLoading(false);
      }
    };

    loadData();
  }, [ctx, userId, selectedPeriod, country]);

  // Handle period type change
  const handlePeriodTypeChange = (type: "monthly" | "quarterly") => {
    setPeriodType(type);
    setSelectedPeriod(getCurrentPeriod(type));
  };

  // Navigate periods
  const goToPreviousPeriod = () => {
    setSelectedPeriod((prev) => {
      if (prev.type === "monthly") {
        const newMonth = prev.period - 1;
        if (newMonth < 1) {
          return { ...prev, year: prev.year - 1, period: 12 };
        }
        return { ...prev, period: newMonth };
      } else {
        const newQuarter = prev.period - 1;
        if (newQuarter < 1) {
          return { ...prev, year: prev.year - 1, period: 4 };
        }
        return { ...prev, period: newQuarter };
      }
    });
  };

  const goToNextPeriod = () => {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    const currentQuarter = Math.ceil(currentMonth / 3);

    setSelectedPeriod((prev) => {
      if (prev.type === "monthly") {
        const newMonth = prev.period + 1;
        // Don't allow going into current or future months
        if (prev.year === currentYear && newMonth >= currentMonth) {
          return prev;
        }
        if (newMonth > 12) {
          if (prev.year + 1 > currentYear) return prev;
          return { ...prev, year: prev.year + 1, period: 1 };
        }
        return { ...prev, period: newMonth };
      } else {
        const newQuarter = prev.period + 1;
        // Don't allow going into current or future quarters
        if (prev.year === currentYear && newQuarter >= currentQuarter) {
          return prev;
        }
        if (newQuarter > 4) {
          if (prev.year + 1 > currentYear) return prev;
          return { ...prev, year: prev.year + 1, period: 1 };
        }
        return { ...prev, period: newQuarter };
      }
    });
  };

  // Deadline info
  const deadline = getUvaDeadline(selectedPeriod);
  const deadlinePassed = isDeadlinePassed(selectedPeriod);

  // Export handlers
  const handleExport = async (format: "pdf" | "xml") => {
    if (!report || !user) return;

    // Check tax number for XML export
    if (format === "xml" && (!userData?.taxNumber || userData.taxNumber.length !== 9)) {
      setExportError("TAX_NUMBER_REQUIRED");
      return;
    }

    setExporting(format);
    setExportError(null);

    try {
      // Get auth token
      const token = await user.getIdToken();

      const response = await fetch("/api/reports/export", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${token}`,
        },
        body: JSON.stringify({
          format,
          report,
          period: selectedPeriod,
          taxNumber: userData?.taxNumber,
          companyName: userData?.companyName,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Export failed");
      }

      const data = await response.json();

      // Create download
      const binaryStr = atob(data.data);
      const bytes = new Uint8Array(binaryStr.length);
      for (let i = 0; i < binaryStr.length; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const blob = new Blob([bytes], { type: data.mimeType });
      const url = URL.createObjectURL(blob);

      // Trigger download
      const a = document.createElement("a");
      a.href = url;
      a.download = data.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error("Export error:", error);
      setExportError(error instanceof Error ? error.message : "Export failed");
    } finally {
      setExporting(null);
    }
  };

  // Submit to FinanzOnline
  const handleSubmitToFinanzOnline = async () => {
    if (!report || !user) return;

    // Check tax number
    if (!userData?.taxNumber || userData.taxNumber.length !== 9) {
      setSubmitResult({
        success: false,
        message: "Tax number (9 digits) is required for FinanzOnline submission",
      });
      return;
    }

    // Check FinanzOnline credentials
    if (!userData?.finanzonline?.isConfigured) {
      setSubmitResult({
        success: false,
        message: "FinanzOnline not configured. Set up your credentials in Settings > Integrations.",
      });
      return;
    }

    setSubmitting(true);
    setSubmitResult(null);

    try {
      const token = await user.getIdToken();

      const response = await fetch("/api/reports/submit", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          report,
          period: selectedPeriod,
          taxNumber: userData.taxNumber,
        }),
      });

      const result = await response.json();

      if (!response.ok || !result.success) {
        throw new Error(result.error || "Submission failed");
      }

      setSubmitResult({
        success: true,
        message: `UVA submitted successfully!${result.referenceNumber ? ` Reference: ${result.referenceNumber}` : ""}`,
      });
    } catch (error) {
      console.error("Submit error:", error);
      setSubmitResult({
        success: false,
        message: error instanceof Error ? error.message : "Failed to submit to FinanzOnline",
      });
    } finally {
      setSubmitting(false);
    }
  };

  // Load account balances
  const loadAccountBalances = async (date: string) => {
    if (!userId || !date) return;
    setBalancesLoading(true);
    try {
      const result = await callFunction<
        { date: string },
        { balances: AccountBalance[]; date: string }
      >("getAccountBalances", { date });
      setAccountBalances(result.balances);
      setBalancesDate(date);
    } catch (error) {
      console.error("Failed to load account balances:", error);
    } finally {
      setBalancesLoading(false);
    }
  };

  // Compute period end date for balance loading
  const getPeriodEndDate = (): string => {
    if (selectedPeriod.type === "monthly") {
      const year = selectedPeriod.year;
      const month = selectedPeriod.period;
      const lastDay = new Date(year, month, 0).getDate();
      return `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    } else {
      const year = selectedPeriod.year;
      const endMonth = selectedPeriod.period * 3;
      const lastDay = new Date(year, endMonth, 0).getDate();
      return `${year}-${String(endMonth).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
    }
  };

  // Check if FinanzOnline submission is available
  const finanzonlineConfigured = userData?.finanzonline?.isConfigured;
  const canSubmitToFinanzOnline =
    readiness?.isReady &&
    report &&
    userData?.taxNumber?.length === 9 &&
    finanzonlineConfigured;

  if (userDataLoading) {
    return (
      <div className="h-full overflow-auto p-6">
        <div className="max-w-5xl mx-auto space-y-6">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-64 w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <FileText className="h-6 w-6" />
              Tax Reports
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              UVA (Umsatzsteuervoranmeldung) for {countryInfo?.label}
            </p>
          </div>
          <Badge variant="outline" className="text-sm">
            {countryInfo?.flag} {countryInfo?.label}
          </Badge>
        </div>

        {/* Period Selector */}
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">Reporting Period</CardTitle>
              {/* Period Type */}
              <Select value={periodType} onValueChange={(v) => handlePeriodTypeChange(v as "monthly" | "quarterly")}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="monthly">Monthly</SelectItem>
                  <SelectItem value="quarterly">Quarterly</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap items-center gap-4 pb-4">
              {/* Period Navigation */}
              <div className="flex items-center gap-2">
                <Button variant="outline" size="icon" onClick={goToPreviousPeriod}>
                  <ChevronLeft className="h-4 w-4" />
                </Button>

                {/* Month/Quarter Dropdown */}
                {periodType === "monthly" ? (
                  <Select
                    value={selectedPeriod.period.toString()}
                    onValueChange={(v) => setSelectedPeriod((prev) => ({ ...prev, period: parseInt(v) }))}
                  >
                    <SelectTrigger className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {MONTHS.map((m) => (
                        <SelectItem key={m.value} value={m.value.toString()}>
                          {m.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : (
                  <Select
                    value={selectedPeriod.period.toString()}
                    onValueChange={(v) => setSelectedPeriod((prev) => ({ ...prev, period: parseInt(v) }))}
                  >
                    <SelectTrigger className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {QUARTERS.map((q) => (
                        <SelectItem key={q.value} value={q.value.toString()}>
                          {q.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}

                {/* Year Dropdown */}
                <Select
                  value={selectedPeriod.year.toString()}
                  onValueChange={(v) => setSelectedPeriod((prev) => ({ ...prev, year: parseInt(v) }))}
                >
                  <SelectTrigger className="w-24">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {getAvailableYears().map((y) => (
                      <SelectItem key={y} value={y.toString()}>
                        {y}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>

                <Button variant="outline" size="icon" onClick={goToNextPeriod}>
                  <ChevronRight className="h-4 w-4" />
                </Button>
              </div>

              <div className="flex-1" />

              {/* Deadline */}
              <div className="flex items-center gap-2 text-sm">
                <Clock className="h-4 w-4 text-muted-foreground" />
                <span className={deadlinePassed ? "text-destructive" : "text-muted-foreground"}>
                  Deadline: {format(deadline, "dd.MM.yyyy", { locale: de })}
                  {deadlinePassed && " (passed)"}
                </span>
              </div>
            </div>

            {/* Timeline Chart */}
            {userId && (
              <div className="-mx-6 -mb-6">
                <div className="border-t" />
                <PeriodTimeline
                  userId={userId}
                  periodType={periodType}
                  selectedPeriod={selectedPeriod}
                  onSelectPeriod={setSelectedPeriod}
                />
              </div>
            )}
          </CardContent>
        </Card>

        {loading ? (
          <div className="space-y-4">
            <Skeleton className="h-32 w-full" />
            <Skeleton className="h-64 w-full" />
          </div>
        ) : (
          <>
            {/* Readiness Check */}
            {readiness && (
              <ReportReadinessCheck
                readiness={readiness}
                period={selectedPeriod}
              />
            )}

            {/* Report Preview */}
            <Tabs defaultValue="preview" className="w-full">
              <TabsList>
                <TabsTrigger value="preview">Preview</TabsTrigger>
                <TabsTrigger value="breakdown">Breakdown</TabsTrigger>
                <TabsTrigger value="balances" onClick={() => {
                  if (!accountBalances) loadAccountBalances(getPeriodEndDate());
                }}>Account Balances</TabsTrigger>
                <TabsTrigger value="export">Export</TabsTrigger>
              </TabsList>

              <TabsContent value="preview" className="mt-4">
                {report && (
                  <UVAPreview
                    report={report}
                    period={selectedPeriod}
                    country={country}
                  />
                )}
              </TabsContent>

              <TabsContent value="breakdown" className="mt-4">
                <Card>
                  <CardHeader>
                    <CardTitle>Transaction Breakdown</CardTitle>
                    <CardDescription>
                      Summary by VAT rate for {formatPeriod(selectedPeriod)}
                    </CardDescription>
                  </CardHeader>
                  <CardContent>
                    {report?.breakdown && report.breakdown.length > 0 ? (
                      <div className="space-y-4">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b">
                              <th className="text-left py-2">VAT Rate</th>
                              <th className="text-right py-2">Transactions</th>
                              <th className="text-right py-2">Net Amount</th>
                              <th className="text-right py-2">VAT Amount</th>
                              <th className="text-right py-2">Gross Amount</th>
                            </tr>
                          </thead>
                          <tbody>
                            {report.breakdown.map((row) => (
                              <tr key={row.rate} className="border-b">
                                <td className="py-2">{row.rate}%</td>
                                <td className="text-right py-2">{row.transactionCount}</td>
                                <td className="text-right py-2 font-mono">
                                  {(row.netAmount / 100).toFixed(2)} EUR
                                </td>
                                <td className="text-right py-2 font-mono">
                                  {(row.vatAmount / 100).toFixed(2)} EUR
                                </td>
                                <td className="text-right py-2 font-mono">
                                  {(row.grossAmount / 100).toFixed(2)} EUR
                                </td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            <tr className="font-medium">
                              <td className="py-2">Total</td>
                              <td className="text-right py-2">
                                {report.transactionCount.total}
                              </td>
                              <td className="text-right py-2 font-mono">
                                {(report.breakdown.reduce((sum, r) => sum + r.netAmount, 0) / 100).toFixed(2)} EUR
                              </td>
                              <td className="text-right py-2 font-mono">
                                {(report.breakdown.reduce((sum, r) => sum + r.vatAmount, 0) / 100).toFixed(2)} EUR
                              </td>
                              <td className="text-right py-2 font-mono">
                                {(report.breakdown.reduce((sum, r) => sum + r.grossAmount, 0) / 100).toFixed(2)} EUR
                              </td>
                            </tr>
                          </tfoot>
                        </table>

                        <div className="grid grid-cols-4 gap-4 pt-4 border-t">
                          <div className="text-center">
                            <div className="text-2xl font-bold">{report.transactionCount.total}</div>
                            <div className="text-xs text-muted-foreground">Total</div>
                          </div>
                          <div className="text-center">
                            <div className="text-2xl font-bold text-green-600">{report.transactionCount.income}</div>
                            <div className="text-xs text-muted-foreground">Income</div>
                          </div>
                          <div className="text-center">
                            <div className="text-2xl font-bold text-red-600">{report.transactionCount.expense}</div>
                            <div className="text-xs text-muted-foreground">Expenses</div>
                          </div>
                          <div className="text-center">
                            <div className="text-2xl font-bold">{report.transactionCount.complete}</div>
                            <div className="text-xs text-muted-foreground">Complete</div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <p className="text-muted-foreground text-center py-8">
                        No transactions found for this period
                      </p>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="balances" className="mt-4">
                <Card>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div>
                        <CardTitle className="flex items-center gap-2">
                          <Wallet className="h-5 w-5" />
                          Account Balances
                        </CardTitle>
                        <CardDescription>
                          Balances at end of {formatPeriod(selectedPeriod)}
                        </CardDescription>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => loadAccountBalances(getPeriodEndDate())}
                        disabled={balancesLoading}
                      >
                        {balancesLoading && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
                        Refresh
                      </Button>
                    </div>
                  </CardHeader>
                  <CardContent>
                    {balancesLoading && !accountBalances ? (
                      <div className="flex items-center justify-center py-8">
                        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                      </div>
                    ) : accountBalances && accountBalances.length > 0 ? (
                      <div className="space-y-4">
                        <table className="w-full text-sm">
                          <thead>
                            <tr className="border-b">
                              <th className="text-left py-2">Account</th>
                              <th className="text-right py-2">Opening Balance</th>
                              <th className="text-right py-2">Transactions</th>
                              <th className="text-right py-2">Balance</th>
                            </tr>
                          </thead>
                          <tbody>
                            {accountBalances.map((ab) => (
                              <tr key={ab.sourceId} className="border-b">
                                <td className="py-2">{ab.sourceName}</td>
                                <td className="text-right py-2 font-mono">
                                  {formatCurrency(ab.openingBalance, ab.currency)}
                                </td>
                                <td className="text-right py-2 font-mono">
                                  {formatCurrency(ab.transactionSum, ab.currency)}
                                </td>
                                <td className={`text-right py-2 font-mono font-medium ${ab.balanceAtDate >= 0 ? "text-green-700" : "text-red-600"}`}>
                                  {formatCurrency(ab.balanceAtDate, ab.currency)}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                          <tfoot>
                            {/* Group by currency for totals */}
                            {Array.from(new Set(accountBalances.map((ab) => ab.currency))).map((currency) => {
                              const currencyBalances = accountBalances.filter((ab) => ab.currency === currency);
                              const total = currencyBalances.reduce((sum, ab) => sum + ab.balanceAtDate, 0);
                              return (
                                <tr key={currency} className="font-medium">
                                  <td className="py-2">Total ({currency})</td>
                                  <td className="text-right py-2 font-mono">
                                    {formatCurrency(
                                      currencyBalances.reduce((sum, ab) => sum + ab.openingBalance, 0),
                                      currency
                                    )}
                                  </td>
                                  <td className="text-right py-2 font-mono">
                                    {formatCurrency(
                                      currencyBalances.reduce((sum, ab) => sum + ab.transactionSum, 0),
                                      currency
                                    )}
                                  </td>
                                  <td className={`text-right py-2 font-mono ${total >= 0 ? "text-green-700" : "text-red-600"}`}>
                                    {formatCurrency(total, currency)}
                                  </td>
                                </tr>
                              );
                            })}
                          </tfoot>
                        </table>
                        <p className="text-xs text-muted-foreground">
                          Balance = Opening Balance + Sum of Transactions up to {balancesDate}
                        </p>
                      </div>
                    ) : accountBalances && accountBalances.length === 0 ? (
                      <p className="text-muted-foreground text-center py-8">
                        No active accounts found
                      </p>
                    ) : (
                      <p className="text-muted-foreground text-center py-8">
                        Click the &quot;Account Balances&quot; tab to load period-end balances
                      </p>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>

              <TabsContent value="export" className="mt-4">
                <Card>
                  <CardHeader>
                    <CardTitle>Export Options</CardTitle>
                    <CardDescription>
                      Download or submit your UVA report
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {!readiness?.isReady && (
                      <div className="flex items-center gap-2 p-4 bg-amber-50 border border-amber-200 rounded-lg text-amber-800">
                        <AlertCircle className="h-5 w-5 flex-shrink-0" />
                        <p className="text-sm">
                          Please complete all transactions before exporting. Missing documentation may cause issues with the Finanzamt.
                        </p>
                      </div>
                    )}

                    {exportError && (
                      <div className="flex items-center gap-2 p-4 bg-red-50 border border-red-200 rounded-lg text-red-800">
                        <AlertCircle className="h-5 w-5 flex-shrink-0" />
                        {exportError === "TAX_NUMBER_REQUIRED" ? (
                          <p className="text-sm">
                            Tax number (9 digits) is required for XML export. Please update it in{" "}
                            <Link href="/settings/identity" className="underline font-medium hover:text-red-900">
                              Settings &gt; Identity
                            </Link>.
                          </p>
                        ) : (
                          <p className="text-sm">{exportError}</p>
                        )}
                      </div>
                    )}

                    <div className="grid gap-4 sm:grid-cols-2">
                      <Button
                        variant="outline"
                        className="h-auto py-4"
                        disabled={!report || exporting !== null}
                        onClick={() => handleExport("pdf")}
                      >
                        <div className="flex flex-col items-center gap-2">
                          {exporting === "pdf" ? (
                            <Loader2 className="h-5 w-5 animate-spin" />
                          ) : (
                            <Download className="h-5 w-5" />
                          )}
                          <span>Download PDF</span>
                          <span className="text-xs text-muted-foreground">For your records</span>
                        </div>
                      </Button>

                      <Button
                        variant="outline"
                        className="h-auto py-4"
                        disabled={!report || exporting !== null}
                        onClick={() => handleExport("xml")}
                      >
                        <div className="flex flex-col items-center gap-2">
                          {exporting === "xml" ? (
                            <Loader2 className="h-5 w-5 animate-spin" />
                          ) : (
                            <Download className="h-5 w-5" />
                          )}
                          <span>Download XML</span>
                          <span className="text-xs text-muted-foreground">FinanzOnline format</span>
                        </div>
                      </Button>
                    </div>

                    {/* FinanzOnline submit - admin only for now */}
                    {isAdmin && (
                      <div className="pt-4 border-t space-y-2">
                        {submitResult && (
                          <div
                            className={`text-sm p-2 rounded ${
                              submitResult.success
                                ? "bg-green-50 text-green-700 border border-green-200"
                                : "bg-red-50 text-red-700 border border-red-200"
                            }`}
                          >
                            {submitResult.message}
                          </div>
                        )}
                        <Button
                          className="w-full"
                          disabled={!canSubmitToFinanzOnline || submitting}
                          onClick={handleSubmitToFinanzOnline}
                        >
                          {submitting ? (
                            <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                          ) : (
                            <ExternalLink className="h-4 w-4 mr-2" />
                          )}
                          {submitting ? "Submitting..." : "Submit to FinanzOnline"}
                        </Button>
                        {!finanzonlineConfigured ? (
                          <p className="text-xs text-muted-foreground text-center mt-2">
                            <Link href="/integrations/finanzonline" className="text-primary underline">
                              Configure FinanzOnline
                            </Link>{" "}
                            to enable direct submission
                          </p>
                        ) : !userData?.taxNumber ? (
                          <p className="text-xs text-muted-foreground text-center mt-2">
                            <Link href="/settings/identity" className="text-primary underline">
                              Add your tax number
                            </Link>{" "}
                            to enable submission
                          </p>
                        ) : (
                          <p className="text-xs text-muted-foreground text-center mt-2">
                            Submits directly to Austrian tax authority (test mode)
                          </p>
                        )}
                      </div>
                    )}
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>
          </>
        )}
      </div>
    </div>
  );
}
