"use client";

import { useState } from "react";
import { startOfYear, format } from "date-fns";
import {
  Download,
  Loader2,
  FileArchive,
  Clock,
  AlertCircle,
  CheckCircle2,
  Building2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { useAuthenticatedDownload } from "@/hooks/use-authenticated-download";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useBmdExports } from "@/hooks/use-bmd-exports";
import { BmdExport } from "@/types/bmd-export";

export function BmdExportSection() {
  const {
    activeExport,
    completedExports,
    loading,
    error,
    requesting,
    requestExport,
    isExpired,
    formatSize,
    getDaysUntilExpiry,
    getProgressPercentage,
  } = useBmdExports();

  // Default: start of current year to today
  const [dateFrom, setDateFrom] = useState(
    format(startOfYear(new Date()), "yyyy-MM-dd")
  );
  const [dateTo, setDateTo] = useState(format(new Date(), "yyyy-MM-dd"));
  const [onlyWithFiles, setOnlyWithFiles] = useState(true);
  const [includeFiles, setIncludeFiles] = useState(true);

  const handleExport = async () => {
    await requestExport({
      dateFrom: new Date(dateFrom).toISOString(),
      dateTo: new Date(dateTo).toISOString(),
      onlyWithFiles,
      includeFiles,
    });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-blue-100 flex items-center justify-center">
            <Building2 className="h-5 w-5 text-blue-600" />
          </div>
          <div>
            <CardTitle className="text-lg">BMD NTCS Export</CardTitle>
            <CardDescription>
              Export transactions and receipts for import into BMD accounting
              software
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Active export progress */}
        {activeExport && (
          <BmdExportProgressCard
            export={activeExport}
            formatSize={formatSize}
            getProgressPercentage={getProgressPercentage}
          />
        )}

        {/* Export options */}
        {!activeExport && (
          <div className="space-y-4">
            {/* Date range */}
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="date-from">From</Label>
                <Input
                  id="date-from"
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="date-to">To</Label>
                <Input
                  id="date-to"
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                />
              </div>
            </div>

            {/* Options */}
            <div className="space-y-3">
              <div className="flex items-start space-x-3">
                <Checkbox
                  id="only-with-files"
                  checked={onlyWithFiles}
                  onCheckedChange={(checked) =>
                    setOnlyWithFiles(checked === true)
                  }
                />
                <div className="space-y-1">
                  <Label
                    htmlFor="only-with-files"
                    className="font-medium cursor-pointer"
                  >
                    Only complete transactions
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Recommended. Only export transactions with receipts or
                    no-receipt categories.
                  </p>
                </div>
              </div>

              <div className="flex items-start space-x-3">
                <Checkbox
                  id="include-files"
                  checked={includeFiles}
                  onCheckedChange={(checked) =>
                    setIncludeFiles(checked === true)
                  }
                />
                <div className="space-y-1">
                  <Label
                    htmlFor="include-files"
                    className="font-medium cursor-pointer"
                  >
                    Include receipt files (PDFs, images)
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    Include actual receipt files in the export. Files are
                    referenced in buchungen.csv via the extbelegnr field.
                  </p>
                </div>
              </div>
            </div>

            {error && (
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error.message}</AlertDescription>
              </Alert>
            )}

            <Button
              onClick={handleExport}
              disabled={requesting || loading}
              className="w-full sm:w-auto"
            >
              {requesting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Starting Export...
                </>
              ) : (
                <>
                  <Download className="mr-2 h-4 w-4" />
                  Export for BMD
                </>
              )}
            </Button>

            <p className="text-xs text-muted-foreground">
              Generates personenkonten.csv (partners) and buchungen.csv
              (bookings) in BMD NTCS format with semicolon separator.
            </p>
          </div>
        )}

        {/* Completed exports */}
        {completedExports.length > 0 && (
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-muted-foreground">
              Recent BMD Exports
            </h4>
            <div className="space-y-2">
              {completedExports.map((exp) => (
                <BmdCompletedExportRow
                  key={exp.id}
                  export={exp}
                  isExpired={isExpired(exp)}
                  formatSize={formatSize}
                  daysUntilExpiry={getDaysUntilExpiry(exp)}
                />
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function BmdExportProgressCard({
  export: exp,
  formatSize,
  getProgressPercentage,
}: {
  export: BmdExport;
  formatSize: (bytes?: number) => string;
  getProgressPercentage: (exp: BmdExport) => number;
}) {
  const getPhaseLabel = (phase: string): string => {
    switch (phase) {
      case "collecting":
        return "Collecting transactions and files...";
      case "generating":
        return "Generating BMD CSV files...";
      case "packaging":
        return "Creating ZIP file...";
      case "uploading":
        return "Uploading...";
      case "complete":
        return "Complete!";
      default:
        return "Processing...";
    }
  };

  return (
    <div className="rounded-lg border bg-muted/50 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <span className="font-medium">BMD Export in Progress</span>
        </div>
        <Badge variant="secondary">{exp.status}</Badge>
      </div>

      <Progress value={getProgressPercentage(exp)} className="h-2" />

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{getPhaseLabel(exp.progress.phase)}</span>
        {exp.progress.currentEntity && (
          <span>Processing: {exp.progress.currentEntity}</span>
        )}
      </div>

      {exp.counts.transactions > 0 && (
        <div className="text-xs text-muted-foreground">
          {exp.counts.transactions} transactions, {exp.counts.files} files,{" "}
          {exp.counts.kreditoren} Kreditoren, {exp.counts.debitoren} Debitoren
        </div>
      )}
    </div>
  );
}

function BmdCompletedExportRow({
  export: exp,
  isExpired,
  formatSize,
  daysUntilExpiry,
}: {
  export: BmdExport;
  isExpired: boolean;
  formatSize: (bytes?: number) => string;
  daysUntilExpiry: number;
}) {
  const storedDownload = useAuthenticatedDownload();
  const completedDate = exp.completedAt?.toDate?.();
  const dateStr = completedDate
    ? completedDate.toLocaleDateString("de-DE", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "Unknown date";

  const dateFromStr = exp.dateFrom?.toDate?.()?.toLocaleDateString("de-DE");
  const dateToStr = exp.dateTo?.toDate?.()?.toLocaleDateString("de-DE");

  return (
    <div className="flex items-center justify-between rounded-lg border p-3">
      <div className="flex items-center gap-3">
        {isExpired ? (
          <AlertCircle className="h-4 w-4 text-muted-foreground" />
        ) : (
          <CheckCircle2 className="h-4 w-4 text-green-600" />
        )}
        <div>
          <div className="text-sm font-medium">{dateStr}</div>
          <div className="text-xs text-muted-foreground">
            {formatSize(exp.zipSize)} &middot; {exp.counts.transactions}{" "}
            transactions
            {dateFromStr && dateToStr && (
              <span>
                {" "}
                &middot; {dateFromStr} - {dateToStr}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2">
        {isExpired ? (
          <Badge variant="secondary" className="text-muted-foreground">
            Expired
          </Badge>
        ) : (
          <>
            <Badge variant="outline" className="text-xs">
              <Clock className="mr-1 h-3 w-3" />
              {daysUntilExpiry} days left
            </Badge>
            {exp.downloadUrl && (
              <Button size="sm" variant="outline" asChild>
                <a
                  href={exp.downloadUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={storedDownload.onClick}
                  aria-busy={storedDownload.pending}
                >
                  <Download className="mr-1 h-3 w-3" />
                  Download
                </a>
              </Button>
            )}
            {storedDownload.error && (
              <p className="text-xs text-destructive">{storedDownload.error}</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
