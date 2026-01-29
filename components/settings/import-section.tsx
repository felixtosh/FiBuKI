"use client";

import { useState, useCallback } from "react";
import { useDropzone } from "react-dropzone";
import {
  Upload,
  FileArchive,
  Loader2,
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { useUserImport } from "@/hooks/use-user-import";

const MAX_FILE_SIZE = 500 * 1024 * 1024; // 500MB

export function ImportSection() {
  const {
    activeImport,
    validation,
    loading,
    error,
    uploading,
    validating,
    importing,
    uploadAndValidate,
    executeImport,
    cancelImport,
    formatSize,
  } = useUserImport();

  const [showConfirmDialog, setShowConfirmDialog] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      const file = acceptedFiles[0];
      if (!file) return;

      setSelectedFile(file);
      await uploadAndValidate(file);
    },
    [uploadAndValidate]
  );

  const { getRootProps, getInputProps, isDragActive, fileRejections } = useDropzone({
    onDrop,
    accept: {
      "application/zip": [".zip"],
      "application/x-zip-compressed": [".zip"],
    },
    maxSize: MAX_FILE_SIZE,
    maxFiles: 1,
    disabled: uploading || validating || !!activeImport,
  });

  const handleConfirmImport = async () => {
    setShowConfirmDialog(false);
    await executeImport();
  };

  const handleCancel = () => {
    setSelectedFile(null);
    cancelImport();
  };

  // Show import progress if active
  if (activeImport && activeImport.status !== "completed") {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Import Data
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ImportProgressCard
            import={activeImport}
            formatSize={formatSize}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Upload className="h-5 w-5" />
            Import Data
          </CardTitle>
          <CardDescription>
            Restore your data from a previously exported ZIP file.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Warning */}
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertTitle>Warning: Import will replace all existing data</AlertTitle>
            <AlertDescription>
              This feature is intended for restoring from a backup or moving data between
              accounts. Your current data will be permanently deleted.
            </AlertDescription>
          </Alert>

          {/* Prerequisites */}
          <div className="text-sm text-muted-foreground">
            <p className="font-medium mb-2">After import:</p>
            <ul className="list-disc list-inside space-y-1">
              <li>Email integrations (Gmail) must be reconnected manually</li>
              <li>Bank connections (GoCardless) must be re-established</li>
            </ul>
          </div>

          {/* Dropzone */}
          {!validation && !uploading && !validating && (
            <div
              {...getRootProps()}
              className={cn(
                "border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-all",
                "hover:border-primary hover:bg-primary/5",
                isDragActive && "border-primary bg-primary/10",
                (uploading || validating) && "pointer-events-none opacity-60"
              )}
            >
              <input {...getInputProps()} />
              <FileArchive className="h-12 w-12 mx-auto mb-4 text-muted-foreground" />
              {isDragActive ? (
                <p className="text-lg font-medium">Drop the ZIP file here</p>
              ) : (
                <>
                  <p className="text-lg font-medium">Choose ZIP File</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    or drag and drop your export ZIP here
                  </p>
                  <p className="text-xs text-muted-foreground mt-2">
                    Maximum file size: {formatSize(MAX_FILE_SIZE)}
                  </p>
                </>
              )}
            </div>
          )}

          {/* File rejections */}
          {fileRejections.length > 0 && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>
                {fileRejections[0].errors[0]?.message || "Invalid file"}
              </AlertDescription>
            </Alert>
          )}

          {/* Upload/validation progress */}
          {(uploading || validating) && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>
                  {uploading
                    ? `Uploading ${selectedFile?.name}...`
                    : "Validating export file..."}
                </span>
              </div>
              <Progress value={uploading ? 50 : 75} className="h-2" />
            </div>
          )}

          {/* Validation results */}
          {validation && (
            <ValidationResults
              validation={validation}
              fileName={selectedFile?.name}
              onImport={() => setShowConfirmDialog(true)}
              onCancel={handleCancel}
              importing={importing}
            />
          )}

          {/* Error display */}
          {error && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertDescription>{error.message}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {/* Confirmation dialog */}
      <Dialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="text-destructive">
              Confirm Data Import
            </DialogTitle>
            <DialogDescription className="space-y-2 pt-2">
              <p>
                <strong>This action will permanently DELETE all your current data:</strong>
              </p>
              <ul className="list-disc list-inside text-sm">
                <li>All bank accounts and transactions</li>
                <li>All receipts and files</li>
                <li>All partners and categories</li>
                <li>All settings and preferences</li>
              </ul>
              <p className="pt-2">
                This cannot be undone. Are you sure you want to proceed?
              </p>
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowConfirmDialog(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={handleConfirmImport}>
              <Trash2 className="mr-2 h-4 w-4" />
              Delete Data & Import
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ValidationResults({
  validation,
  fileName,
  onImport,
  onCancel,
  importing,
}: {
  validation: {
    valid: boolean;
    version: string;
    counts: Record<string, number>;
    errors: string[];
    warnings: string[];
  };
  fileName?: string;
  onImport: () => void;
  onCancel: () => void;
  importing: boolean;
}) {
  return (
    <div className="space-y-4 rounded-lg border p-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {validation.valid ? (
            <CheckCircle2 className="h-5 w-5 text-green-600" />
          ) : (
            <AlertCircle className="h-5 w-5 text-destructive" />
          )}
          <span className="font-medium">
            {validation.valid ? "Valid Export File" : "Invalid Export File"}
          </span>
        </div>
        <Badge variant="secondary">v{validation.version}</Badge>
      </div>

      {fileName && (
        <div className="text-sm text-muted-foreground">{fileName}</div>
      )}

      {/* Counts */}
      <div className="grid grid-cols-2 gap-2 text-sm">
        {Object.entries(validation.counts).map(([key, count]) => (
          <div key={key} className="flex justify-between">
            <span className="text-muted-foreground capitalize">
              {key.replace(/([A-Z])/g, " $1").trim()}:
            </span>
            <span className="font-medium">{count}</span>
          </div>
        ))}
      </div>

      {/* Errors */}
      {validation.errors.length > 0 && (
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>Errors</AlertTitle>
          <AlertDescription>
            <ul className="list-disc list-inside">
              {validation.errors.map((err, i) => (
                <li key={i}>{err}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {/* Warnings */}
      {validation.warnings.length > 0 && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Warnings</AlertTitle>
          <AlertDescription>
            <ul className="list-disc list-inside">
              {validation.warnings.map((warn, i) => (
                <li key={i}>{warn}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        <Button variant="outline" onClick={onCancel} disabled={importing}>
          Cancel
        </Button>
        {validation.valid && (
          <Button onClick={onImport} disabled={importing} variant="destructive">
            {importing ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Importing...
              </>
            ) : (
              <>
                <Upload className="mr-2 h-4 w-4" />
                Import Data
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  );
}

function ImportProgressCard({
  import: imp,
  formatSize,
}: {
  import: {
    status: string;
    progress: {
      phase: string;
      current: number;
      total: number;
      currentEntity?: string;
    };
    importedCounts?: Record<string, number>;
  };
  formatSize: (bytes?: number) => string;
}) {
  const getPhaseLabel = (phase: string): string => {
    switch (phase) {
      case "validating":
        return "Validating...";
      case "wiping":
        return "Deleting existing data...";
      case "importing":
        return "Importing data...";
      case "complete":
        return "Complete!";
      default:
        return "Processing...";
    }
  };

  const getProgressValue = (phase: string): number => {
    switch (phase) {
      case "validating":
        return 10;
      case "wiping":
        return 30;
      case "importing":
        return 60;
      case "complete":
        return 100;
      default:
        return 5;
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin text-primary" />
        <span className="font-medium">Import in Progress</span>
        <Badge variant="secondary">{imp.status}</Badge>
      </div>

      <Progress value={getProgressValue(imp.progress.phase)} className="h-2" />

      <div className="flex items-center justify-between text-sm text-muted-foreground">
        <span>{getPhaseLabel(imp.progress.phase)}</span>
        {imp.progress.currentEntity && (
          <span>Processing: {imp.progress.currentEntity}</span>
        )}
      </div>
    </div>
  );
}
