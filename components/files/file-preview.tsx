"use client";

import { FileText, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useState } from "react";
import { useFileObjectUrl } from "@/hooks/use-file-object-url";

interface FilePreviewProps {
  downloadUrl: string;
  fileType: string;
  fileName: string;
  className?: string;
  onClick?: () => void;
  /** Full size mode - fills container instead of using aspect ratio */
  fullSize?: boolean;
  /** Active state - shows visual feedback when viewer is open */
  active?: boolean;
}

/**
 * File preview component - supports both thumbnail and full-size modes
 */
export function FilePreview({
  downloadUrl,
  fileType,
  fileName,
  className,
  onClick,
  fullSize = false,
  active = false,
}: FilePreviewProps) {
  const lowerName = fileName.toLowerCase();
  const isPdf =
    fileType === "application/pdf" ||
    (fileType === "application/octet-stream" && lowerName.endsWith(".pdf"));
  const isImage =
    fileType.startsWith("image/") ||
    (fileType === "application/octet-stream" &&
      /\.(png|jpe?g|gif|webp)$/.test(lowerName));
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  // The `downloadUrl` prop is the STORED url, which on the self-host stack needs
  // an Authorization header and so cannot be an iframe/img src directly. Resolved
  // here rather than at each of the ~9 call sites, so every caller is fixed at
  // once and the prop contract stays "the url on the document". Firebase URLs pass
  // through untouched. See hooks/use-file-object-url.ts.
  const resolved = useFileObjectUrl(downloadUrl);
  const srcUrl = resolved.url;
  const isLoading = loading || resolved.loading;
  const hasError = error || resolved.error !== null;

  if (fullSize) {
    return (
      <div
        className={cn(
          "relative w-full h-full bg-muted/30 overflow-hidden",
          onClick && "cursor-pointer hover:ring-2 hover:ring-primary/50 transition-all",
          className
        )}
        onClick={onClick}
      >
        {isLoading && !hasError && (
          <div className="absolute inset-0 flex items-center justify-center bg-muted/50">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
          </div>
        )}
        {hasError ? (
          <div className="w-full h-full flex flex-col items-center justify-center text-muted-foreground">
            <FileText className="h-12 w-12 mb-2" />
            <p className="text-sm">Failed to load preview</p>
            <p className="text-xs">{fileName}</p>
          </div>
        ) : isPdf && srcUrl ? (
          // Guarded on srcUrl: a template literal over a null would render the
          // string "null#toolbar=0..." and the viewer would report a load failure
          // for what is only a not-yet-resolved url.
          <iframe
            src={`${srcUrl}#toolbar=0&navpanes=0&view=FitH`}
            className="w-full h-full border-0"
            title={fileName}
            onLoad={() => setLoading(false)}
            onError={() => { setLoading(false); setError(true); }}
          />
        ) : isImage ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={srcUrl ?? undefined}
            alt={fileName}
            className="w-full h-full object-contain"
            onLoad={() => setLoading(false)}
            onError={() => { setLoading(false); setError(true); }}
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center text-muted-foreground">
            <FileText className="h-12 w-12 mb-2" />
            <p className="text-sm">{fileName}</p>
            <p className="text-xs text-muted-foreground">{fileType}</p>
          </div>
        )}
      </div>
    );
  }

  // Get file extension for badge
  const getFileExtension = () => {
    if (isPdf) return "PDF";
    if (isImage) {
      if (fileType.startsWith("image/")) {
        const ext = fileType.split("/")[1]?.toUpperCase();
        return ext === "JPEG" ? "JPG" : ext;
      }
      if (/\.(png|jpe?g|gif|webp)$/.test(lowerName)) {
        const ext = lowerName.split(".").pop()?.toUpperCase();
        return ext === "JPEG" ? "JPG" : ext || "IMG";
      }
      return "IMG";
    }
    if (fileType === "application/octet-stream" && lowerName.endsWith(".pdf")) {
      return "PDF";
    }
    if (fileType.startsWith("image/")) {
      const ext = fileType.split("/")[1]?.toUpperCase();
      return ext === "JPEG" ? "JPG" : ext;
    }
    return fileType.split("/")[1]?.toUpperCase() || "FILE";
  };

  // Thumbnail mode (original behavior)
  return (
    <div
      className={cn(
        "relative bg-muted/30 rounded-md overflow-hidden cursor-pointer transition-all",
        active
          ? "ring-2 ring-primary shadow-md"
          : "hover:ring-2 hover:ring-primary/50",
        className
      )}
      onClick={onClick}
    >
      {isPdf && srcUrl ? (
        <div className="aspect-[3/4] flex items-center justify-center bg-background">
          <iframe
            src={`${srcUrl}#toolbar=0&navpanes=0&scrollbar=0&view=FitH`}
            className="w-full h-full border-0 pointer-events-none"
            title={fileName}
          />
        </div>
      ) : isPdf ? (
        // Resolving, or failed — show the placeholder rather than a broken frame.
        <div className="aspect-[3/4] flex items-center justify-center bg-background text-muted-foreground">
          {isLoading && !hasError ? (
            <Loader2 className="h-6 w-6 animate-spin" />
          ) : (
            <FileText className="h-8 w-8" />
          )}
        </div>
      ) : isImage ? (
        <div className="aspect-[3/4] flex items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={srcUrl ?? undefined}
            alt={fileName}
            className="w-full h-full object-cover"
          />
        </div>
      ) : (
        <div className="aspect-[3/4] flex flex-col items-center justify-center text-muted-foreground">
          <FileText className="h-8 w-8" />
        </div>
      )}
      {/* File type badge */}
      <div className="absolute bottom-1 right-1 px-1.5 py-0.5 text-[10px] font-medium bg-background/90 backdrop-blur-sm rounded border border-border/50 text-muted-foreground">
        {getFileExtension()}
      </div>
    </div>
  );
}
