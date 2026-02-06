"use client";

import Link from "next/link";
import { Progress } from "@/components/ui/progress";
import { CheckCircle2, XCircle, Loader2, FileText, X, Copy } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

export interface FileUploadStatus {
  id: string;
  fileName: string;
  progress: number;
  status: "uploading" | "complete" | "error";
  error?: string;
  fileId?: string; // Firestore document ID after successful upload
  duplicateFileId?: string; // ID of existing file if this was a duplicate
  duplicateFileName?: string; // Name of existing file if this was a duplicate
}

interface UploadProgressProps {
  uploads: FileUploadStatus[];
  onDismiss?: () => void;
  className?: string;
}

export function UploadProgress({ uploads, onDismiss, className }: UploadProgressProps) {
  const totalFiles = uploads.length;
  const completedFiles = uploads.filter((u) => u.status === "complete").length;
  const duplicateFiles = uploads.filter((u) => u.status === "error" && u.duplicateFileId);
  const otherErrorFiles = uploads.filter((u) => u.status === "error" && !u.duplicateFileId);
  const uploadingFiles = uploads.filter((u) => u.status === "uploading");

  // Calculate overall progress (duplicates count as processed)
  const overallProgress =
    totalFiles > 0
      ? Math.round(uploads.reduce((sum, u) => sum + u.progress, 0) / totalFiles)
      : 0;

  const isComplete = completedFiles + duplicateFiles.length + otherErrorFiles.length === totalFiles;
  const allSuccessful = isComplete && duplicateFiles.length === 0 && otherErrorFiles.length === 0;

  // Build status message
  const getStatusMessage = () => {
    if (!isComplete) {
      return `Uploading ${totalFiles} file${totalFiles !== 1 ? "s" : ""}...`;
    }
    if (allSuccessful) {
      return `${completedFiles} file${completedFiles !== 1 ? "s" : ""} uploaded`;
    }
    const parts: string[] = [];
    if (completedFiles > 0) {
      parts.push(`${completedFiles} uploaded`);
    }
    if (duplicateFiles.length > 0) {
      parts.push(`${duplicateFiles.length} duplicate${duplicateFiles.length !== 1 ? "s" : ""}`);
    }
    if (otherErrorFiles.length > 0) {
      parts.push(`${otherErrorFiles.length} failed`);
    }
    return parts.join(", ");
  };

  return (
    <div className={cn("bg-background/95 backdrop-blur border-t px-4 py-3 shadow-lg", className)}>
      <div className="flex items-center gap-4">
        {/* Status icon */}
        <div className="flex-shrink-0">
          {isComplete ? (
            allSuccessful ? (
              <CheckCircle2 className="h-5 w-5 text-green-600 animate-check-appear" />
            ) : otherErrorFiles.length > 0 ? (
              <XCircle className="h-5 w-5 text-destructive" />
            ) : (
              <Copy className="h-5 w-5 text-muted-foreground" />
            )
          ) : (
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
          )}
        </div>

        {/* Progress info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-1">
            <span className="text-sm font-medium truncate">
              {getStatusMessage()}
            </span>
            <span className="text-sm text-muted-foreground ml-2">
              {overallProgress}%
            </span>
          </div>
          <Progress value={overallProgress} className="h-1.5" />

          {/* Show current uploading files */}
          {uploadingFiles.length > 0 && uploadingFiles.length <= 3 && (
            <div className="flex items-center gap-3 mt-1.5">
              {uploadingFiles.map((upload) => (
                <div key={upload.id} className="flex items-center gap-1 text-xs text-muted-foreground">
                  <FileText className="h-3 w-3" />
                  <span className="truncate max-w-[120px]">{upload.fileName}</span>
                  <span>({upload.progress}%)</span>
                </div>
              ))}
            </div>
          )}

          {/* Show duplicates if any */}
          {duplicateFiles.length > 0 && isComplete && (
            <div className="mt-1.5 text-xs text-muted-foreground">
              {duplicateFiles.slice(0, 3).map((u) => (
                <div key={u.id} className="flex items-center gap-1 truncate">
                  <Copy className="h-3 w-3 flex-shrink-0" />
                  <span className="truncate">{u.fileName}</span>
                  <span className="text-muted-foreground/70">→</span>
                  <Link
                    href={`/files?id=${u.duplicateFileId}`}
                    className="text-primary hover:underline truncate"
                  >
                    {u.duplicateFileName}
                  </Link>
                </div>
              ))}
              {duplicateFiles.length > 3 && (
                <div className="text-muted-foreground/70">
                  ...and {duplicateFiles.length - 3} more duplicate{duplicateFiles.length - 3 !== 1 ? "s" : ""}
                </div>
              )}
            </div>
          )}

          {/* Show other errors if any */}
          {otherErrorFiles.length > 0 && isComplete && (
            <div className="mt-1.5 text-xs text-destructive">
              {otherErrorFiles.slice(0, 3).map((u) => (
                <div key={u.id} className="truncate">
                  {u.fileName}: {u.error || "Upload failed"}
                </div>
              ))}
              {otherErrorFiles.length > 3 && (
                <div>...and {otherErrorFiles.length - 3} more error{otherErrorFiles.length - 3 !== 1 ? "s" : ""}</div>
              )}
            </div>
          )}
        </div>

        {/* Dismiss button (only when complete) */}
        {isComplete && onDismiss && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onDismiss}
            className="flex-shrink-0 h-7 w-7 p-0"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
