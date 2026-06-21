"use client";

import { useState, useEffect } from "react";
import {
  ZoomIn,
  ZoomOut,
  RotateCw,
  Download,
  ExternalLink,
  FileText,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContentOverlay } from "@/components/ui/content-overlay";
import { PdfPageViewer } from "./pdf-page-viewer";

interface FileViewerOverlayProps {
  open: boolean;
  onClose: () => void;
  downloadUrl: string;
  fileType: string;
  fileName: string;
  /** Text to highlight and scroll to in the PDF */
  highlightText?: string | null;
}

export function FileViewerOverlay({
  open,
  onClose,
  downloadUrl,
  fileType,
  fileName,
  highlightText,
}: FileViewerOverlayProps) {
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);

  const isPdf = fileType === "application/pdf";
  const isImage = fileType.startsWith("image/");

  const handleZoomIn = () => setZoom((z) => Math.min(z + 0.25, 3));
  const handleZoomOut = () => setZoom((z) => Math.max(z - 0.25, 0.5));
  const handleRotate = () => setRotation((r) => (r + 90) % 360);

  // Cross-origin downloads ignore the <a download> attribute, so the browser
  // just opens the PDF inline instead of saving it. Fetch the file ourselves
  // and hand the blob to a same-origin object URL — the download attribute
  // is honored for blob: URLs and the filename is preserved.
  const handleDownload = async (e: React.MouseEvent) => {
    e.preventDefault();
    try {
      const res = await fetch(downloadUrl);
      if (!res.ok) throw new Error(`fetch failed: ${res.status}`);
      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(blobUrl), 0);
    } catch (err) {
      console.warn("Blob download failed, falling back to direct link:", err);
      window.location.href = downloadUrl;
    }
  };

  // Reset state when file changes
  useEffect(() => {
    setZoom(1);
    setRotation(0);
  }, [downloadUrl]);

  const headerActions = (
    <>
      {/* Zoom controls */}
      <Button
        variant="ghost"
        size="icon"
        onClick={handleZoomOut}
        className="h-8 w-8"
        disabled={zoom <= 0.5}
      >
        <ZoomOut className="h-4 w-4" />
      </Button>
      <span className="text-sm text-muted-foreground w-12 text-center">
        {Math.round(zoom * 100)}%
      </span>
      <Button
        variant="ghost"
        size="icon"
        onClick={handleZoomIn}
        className="h-8 w-8"
        disabled={zoom >= 3}
      >
        <ZoomIn className="h-4 w-4" />
      </Button>

      {/* Rotate (images only) */}
      {isImage && (
        <Button
          variant="ghost"
          size="icon"
          onClick={handleRotate}
          className="h-8 w-8"
        >
          <RotateCw className="h-4 w-4" />
        </Button>
      )}

      <div className="w-px h-6 bg-border mx-1" />

      {/* Download */}
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={handleDownload}
      >
        <Download className="h-4 w-4" />
      </Button>

      {/* Open in new tab */}
      <Button variant="ghost" size="icon" className="h-8 w-8" asChild>
        <a href={downloadUrl} target="_blank" rel="noopener noreferrer">
          <ExternalLink className="h-4 w-4" />
        </a>
      </Button>
    </>
  );

  return (
    <ContentOverlay
      open={open}
      onClose={onClose}
      title={fileName}
      headerActions={headerActions}
    >
      <div className="h-full bg-muted/30">
        {isPdf ? (
          <PdfPageViewer
            url={downloadUrl}
            scale={zoom}
            rotation={rotation}
            highlightText={highlightText}
            className="h-full"
          />
        ) : isImage ? (
          <div className="h-full flex items-center justify-center p-4 overflow-auto">
            <div
              className="transition-transform duration-200"
              style={{
                transform: `scale(${zoom}) rotate(${rotation}deg)`,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={downloadUrl}
                alt={fileName}
                className="max-w-full max-h-[calc(100vh-200px)] object-contain rounded-lg shadow-lg"
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 text-muted-foreground p-8">
            <FileText className="h-16 w-16" />
            <p className="text-sm">Preview not available</p>
            <Button variant="outline" onClick={handleDownload}>
              Download file
            </Button>
          </div>
        )}
      </div>
    </ContentOverlay>
  );
}
