"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// Import react-pdf styles for text layer
import "react-pdf/dist/Page/TextLayer.css";

// Dynamically import react-pdf to avoid SSR issues
const Document = dynamic(
  () => import("react-pdf").then((mod) => mod.Document),
  { ssr: false }
);

const Page = dynamic(
  () => import("react-pdf").then((mod) => mod.Page),
  { ssr: false }
);

// Configure PDF.js worker — self-host instead of loading from unpkg.com so
// the strict Content-Security-Policy doesn't block it. `new URL(..., import.meta.url)`
// is the documented pdfjs-dist pattern for bundlers (Next.js / Turbopack
// resolve this to a same-origin URL).
if (typeof window !== "undefined") {
  import("react-pdf").then((mod) => {
    mod.pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      "pdfjs-dist/build/pdf.worker.min.mjs",
      import.meta.url,
    ).toString();
  });
}

interface PdfPageViewerProps {
  url: string;
  scale?: number;
  rotation?: number;
  onDocumentLoad?: (numPages: number) => void;
  /** Text to highlight in the PDF */
  highlightText?: string | null;
  className?: string;
}

export function PdfPageViewer({
  url,
  scale = 1,
  rotation = 0,
  onDocumentLoad,
  highlightText,
  className,
}: PdfPageViewerProps) {
  const [numPages, setNumPages] = useState<number>(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleDocumentLoadSuccess = useCallback(
    ({ numPages }: { numPages: number }) => {
      setNumPages(numPages);
      setIsLoading(false);
      setError(null);
      onDocumentLoad?.(numPages);
    },
    [onDocumentLoad]
  );

  const handleDocumentLoadError = useCallback((err: Error) => {
    console.error("PDF load error:", err);
    setError("Failed to load PDF");
    setIsLoading(false);
  }, []);

  // Highlight text in the PDF text layer (searches all pages)
  useEffect(() => {
    if (!highlightText || !containerRef.current || isLoading) return;

    // Small delay to ensure text layers are rendered
    const timeoutId = setTimeout(() => {
      const container = containerRef.current;
      if (!container) return;

      // Remove previous highlights from all pages
      container.querySelectorAll(".pdf-highlight").forEach((el) => {
        const parent = el.parentNode;
        if (parent) {
          parent.replaceChild(document.createTextNode(el.textContent || ""), el);
          parent.normalize();
        }
      });

      // Search for the text in all text spans across all pages
      const baseSearch = highlightText.toLowerCase().trim();
      const searchVariations = [baseSearch];

      // If it looks like a number, add variations with different decimal separators
      if (/^\d+[.,]\d+$/.test(baseSearch)) {
        searchVariations.push(baseSearch.replace(",", "."));
        searchVariations.push(baseSearch.replace(".", ","));
      }

      const spans = container.querySelectorAll(".react-pdf__Page__textContent span");
      const foundElements: HTMLElement[] = [];

      spans.forEach((span) => {
        const text = span.textContent || "";
        const lowerText = text.toLowerCase();

        // Try each search variation
        for (const searchText of searchVariations) {
          const index = lowerText.indexOf(searchText);

          if (index !== -1) {
            // Create highlighted version
            const before = text.substring(0, index);
            const match = text.substring(index, index + searchText.length);
            const after = text.substring(index + searchText.length);

            span.innerHTML = "";
            if (before) span.appendChild(document.createTextNode(before));

            const highlight = document.createElement("mark");
            highlight.className = "pdf-highlight";
            highlight.style.cssText = "background-color: var(--color-highlight); padding: 2px 0; border-radius: 2px;";
            highlight.textContent = match;
            span.appendChild(highlight);

            if (after) span.appendChild(document.createTextNode(after));

            foundElements.push(highlight);
            break; // Found a match, don't try other variations for this span
          }
        }
      });

      // Scroll to the first match
      if (foundElements.length > 0) {
        foundElements[0].scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }, 200); // Slightly longer delay to ensure all pages are rendered

    return () => clearTimeout(timeoutId);
  }, [highlightText, isLoading, numPages]);

  return (
    <div className={cn("flex flex-col h-full", className)}>
      {/* PDF Document - all pages stacked vertically */}
      <div
        ref={containerRef}
        className="flex-1 min-h-0 overflow-auto p-4"
      >
        <Document
          file={url}
          onLoadSuccess={handleDocumentLoadSuccess}
          onLoadError={handleDocumentLoadError}
          loading={
            <div className="flex items-center justify-center p-8">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            </div>
          }
          error={
            <div className="text-destructive text-center p-8">
              {error || "Failed to load PDF"}
            </div>
          }
        >
          {!isLoading && !error && (
            <div className="flex flex-col items-center gap-4">
              {Array.from({ length: numPages }, (_, index) => (
                <Page
                  key={index}
                  pageNumber={index + 1}
                  scale={scale}
                  rotate={rotation}
                  renderTextLayer={true}
                  renderAnnotationLayer={false}
                  loading={
                    <div className="flex items-center justify-center p-8">
                      <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
                    </div>
                  }
                  className="shadow-lg"
                />
              ))}
            </div>
          )}
        </Document>
      </div>

      {/* Page count indicator */}
      {numPages > 1 && (
        <div className="flex items-center justify-center py-2 border-t bg-muted/30">
          <span className="text-sm text-muted-foreground">
            {numPages} pages
          </span>
        </div>
      )}
    </div>
  );
}
