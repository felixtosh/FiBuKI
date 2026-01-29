"use client";

import { useState } from "react";
import {
  Download,
  Loader2,
  FileArchive,
  Clock,
  AlertCircle,
  CheckCircle2,
  ExternalLink,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { useUserExports } from "@/hooks/use-user-exports";
import { UserExport } from "@/types/user-export";

export function ExportSection() {
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
  } = useUserExports();

  const [includeFiles, setIncludeFiles] = useState(false);

  const handleExport = async () => {
    await requestExport(includeFiles);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Download className="h-5 w-5" />
          Export Your Data
        </CardTitle>
        <CardDescription>
          Download all your FiBuKI data as a ZIP file. The export includes bank accounts,
          transactions, receipts, partners, and categories.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Active export progress */}
        {activeExport && (
          <ExportProgressCard export={activeExport} formatSize={formatSize} />
        )}

        {/* Export options */}
        {!activeExport && (
          <div className="space-y-4">
            <div className="flex items-start space-x-3">
              <Checkbox
                id="include-files"
                checked={includeFiles}
                onCheckedChange={(checked) => setIncludeFiles(checked === true)}
              />
              <div className="space-y-1">
                <Label htmlFor="include-files" className="font-medium cursor-pointer">
                  Include actual files (PDFs, images)
                </Label>
                <p className="text-sm text-muted-foreground">
                  This may significantly increase download size and export time.
                  Without this option, only file metadata is exported.
                </p>
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
                  <FileArchive className="mr-2 h-4 w-4" />
                  Export Data
                </>
              )}
            </Button>
          </div>
        )}

        {/* Completed exports */}
        {completedExports.length > 0 && (
          <div className="space-y-3">
            <h4 className="text-sm font-medium text-muted-foreground">Recent Exports</h4>
            <div className="space-y-2">
              {completedExports.map((exp) => (
                <CompletedExportRow
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

function ExportProgressCard({
  export: exp,
  formatSize,
}: {
  export: UserExport;
  formatSize: (bytes?: number) => string;
}) {
  const getPhaseLabel = (phase: string): string => {
    switch (phase) {
      case "collecting":
        return "Collecting data...";
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

  const getProgressValue = (phase: string): number => {
    switch (phase) {
      case "collecting":
        return 25;
      case "packaging":
        return 50;
      case "uploading":
        return 75;
      case "complete":
        return 100;
      default:
        return 10;
    }
  };

  return (
    <div className="rounded-lg border bg-muted/50 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-primary" />
          <span className="font-medium">Export in Progress</span>
        </div>
        <Badge variant="secondary">{exp.status}</Badge>
      </div>

      <Progress value={getProgressValue(exp.progress.phase)} className="h-2" />

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{getPhaseLabel(exp.progress.phase)}</span>
        {exp.progress.currentEntity && (
          <span>Processing: {exp.progress.currentEntity}</span>
        )}
      </div>

      {exp.counts.transactions > 0 && (
        <div className="text-xs text-muted-foreground">
          {exp.counts.sources} sources, {exp.counts.transactions} transactions,{" "}
          {exp.counts.files} files, {exp.counts.partners} partners
        </div>
      )}
    </div>
  );
}

function CompletedExportRow({
  export: exp,
  isExpired,
  formatSize,
  daysUntilExpiry,
}: {
  export: UserExport;
  isExpired: boolean;
  formatSize: (bytes?: number) => string;
  daysUntilExpiry: number;
}) {
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
            {formatSize(exp.zipSize)}
            {exp.includeStorageFiles && " (with files)"}
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
                <a href={exp.downloadUrl} target="_blank" rel="noopener noreferrer">
                  <Download className="mr-1 h-3 w-3" />
                  Download
                </a>
              </Button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
