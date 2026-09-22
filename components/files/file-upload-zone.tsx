"use client";

import { useCallback } from "react";
import { useDropzone } from "react-dropzone";
import { Upload, X } from "lucide-react";
import { cn } from "@/lib/utils";

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ACCEPTED_TYPES = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "application/pdf": [".pdf"],
};

interface FileUploadZoneProps {
  /** Hand the dropped files to the page's upload pipeline. */
  onFilesAccepted: (files: File[]) => void;
  className?: string;
}

/**
 * The dialog's drop target — a target, and nothing else.
 *
 * It used to carry its own hash / duplicate-check / storage-upload / createFile
 * sequence, a second copy of the one on the Files page that renders it. Two
 * pipelines on one page is what wrote two Files for a single drop (#182): the
 * event reached both. The page owns the pipeline now, including its progress
 * reporting; this hands the files over.
 */
export function FileUploadZone({ onFilesAccepted, className }: FileUploadZoneProps) {
  const onDrop = useCallback(
    (acceptedFiles: File[]) => {
      if (acceptedFiles.length > 0) {
        onFilesAccepted(acceptedFiles);
      }
    },
    [onFilesAccepted]
  );

  const { getRootProps, getInputProps, isDragActive, fileRejections } = useDropzone({
    onDrop,
    accept: ACCEPTED_TYPES,
    maxSize: MAX_FILE_SIZE,
    multiple: true,
  });

  // Show rejection error
  const rejectionError =
    fileRejections.length > 0
      ? fileRejections[0].errors[0].code === "file-too-large"
        ? "File too large (max 10MB)"
        : "Invalid file type (only PDF, JPG, PNG, WebP)"
      : null;

  return (
    <div className={cn("space-y-2", className)}>
      <div
        {...getRootProps()}
        className={cn(
          "border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer",
          isDragActive && "border-primary bg-primary/5",
          rejectionError && "border-destructive",
          !isDragActive && !rejectionError && "hover:border-primary/50 hover:bg-muted/50"
        )}
      >
        <input {...getInputProps()} />

        <div className="space-y-2">
          <Upload className="h-8 w-8 mx-auto text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">
              {isDragActive ? "Drop file here" : "Drop file or click to upload"}
            </p>
            <p className="text-xs text-muted-foreground">
              PDF, JPG, PNG, or WebP up to 10MB
            </p>
          </div>
        </div>
      </div>

      {rejectionError && (
        <div className="flex items-center gap-2 text-sm text-destructive bg-destructive/10 px-3 py-2 rounded">
          <X className="h-4 w-4 flex-shrink-0" />
          {rejectionError}
        </div>
      )}
    </div>
  );
}
