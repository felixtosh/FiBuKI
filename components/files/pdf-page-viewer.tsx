"use client";

import { useState, useCallback, useEffect, useRef, type RefObject } from "react";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { FileText, Loader2, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { pdfjsWasmUrl } from "@/lib/pdf/pdfjs-wasm.mjs";
import pdfjsPackage from "pdfjs-dist/package.json";

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

// pdf.js options for every Document here, the viewer's and the thumbnail's.
// `wasmUrl`: pdf.js decodes JPEG 2000 page images (most scanners' output) with
// a wasm module fetched from there; without it a scan draws blank (#681).
// The decoders are copied into public/ for the installed pdf.js version by
// scripts/copy-pdfjs-wasm.mjs. One object at module scope: react-pdf reloads
// the document whenever `options` changes identity.
export const PDF_DOCUMENT_OPTIONS = {
  wasmUrl: pdfjsWasmUrl(pdfjsPackage.version),
};

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
  const t = useTranslations("documents.viewer");
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

  // Keyed to the url, not a flag: the overlay keeps this viewer mounted while
  // the user picks another File, and that File must load normally.
  const [protectedUrl, setProtectedUrl] = useState<string | null>(null);
  const passwordProtected = protectedUrl === url;

  // react-pdf's default handler asks with window.prompt() and passes the answer
  // straight on. Cancel yields null, pdf.js rejects it as a wrong password and
  // asks again, so the dialog can never be dismissed. Never answer instead:
  // flag the file and unmount the Document, whose cleanup destroys the pending load.
  const handlePassword = useCallback(() => {
    setProtectedUrl(url);
    setIsLoading(false);
  }, [url]);

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
        {passwordProtected ? (
          <div className="flex flex-col items-center gap-3 p-8 text-center text-muted-foreground">
            <Lock className="h-10 w-10" />
            <p className="text-sm">{t("passwordProtected")}</p>
          </div>
        ) : (
          <Document
            file={url}
            options={PDF_DOCUMENT_OPTIONS}
            onLoadSuccess={handleDocumentLoadSuccess}
            onLoadError={handleDocumentLoadError}
            onPassword={handlePassword}
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
        )}
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

/**
 * The first page of a PDF, drawn at its container's width: the thumbnail in a
 * File's detail panel (#676). It replaces an iframe of the browser's own PDF
 * viewer, which for a password-protected PDF showed its own password box and
 * took keyboard focus away from the list's arrow keys.
 *
 * Nothing in here can take focus: the page is a canvas, and the text and
 * annotation layers (selectable text, link anchors) are not rendered. A
 * protected PDF gets the same never-answer password handling as the viewer.
 */
export function PdfThumbnail({ url }: { url: string }) {
  const t = useTranslations("documents.viewer");
  const [containerRef, width] = useElementWidth();

  // Keyed to the url, like the viewer: the detail panel keeps this mounted
  // while the user steps to the next File, and that File must load normally.
  // Never answered: flagging the url unmounts the Document, which drops the load.
  const [protectedUrl, setProtectedUrl] = useState<string | null>(null);
  const handlePassword = useCallback(() => {
    setProtectedUrl(url);
  }, [url]);

  return (
    <div ref={containerRef} className="relative w-full h-full overflow-hidden">
      {protectedUrl === url ? (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-2 text-center text-muted-foreground"
          title={t("passwordProtected")}
        >
          <Lock className="h-6 w-6" />
          <p className="text-[11px] leading-tight">{t("passwordProtectedShort")}</p>
        </div>
      ) : (
        <Document
          file={url}
          options={PDF_DOCUMENT_OPTIONS}
          onPassword={handlePassword}
          loading={<ThumbnailLoading />}
          error={<ThumbnailFailed />}
          noData={<ThumbnailLoading />}
        >
          {width > 0 && (
            <Page
              pageNumber={1}
              width={width}
              renderTextLayer={false}
              renderAnnotationLayer={false}
              loading={<ThumbnailLoading />}
              error={<ThumbnailFailed />}
            />
          )}
        </Document>
      )}
    </div>
  );
}

// In normal flow at the thumbnail's 3:4, not absolutely positioned: react-pdf
// renders these inside its own Document div or its (relative, zero-height) Page div.
function ThumbnailLoading() {
  return (
    <div className="flex aspect-[3/4] w-full items-center justify-center text-muted-foreground">
      <Loader2 className="h-6 w-6 animate-spin" />
    </div>
  );
}

function ThumbnailFailed() {
  return (
    <div className="flex aspect-[3/4] w-full items-center justify-center text-muted-foreground">
      <FileText className="h-8 w-8" />
    </div>
  );
}

/** A ref and its element's content width in whole pixels, kept current as it resizes. */
function useElementWidth(): [RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => setWidth(Math.floor(element.clientWidth));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return [ref, width];
}
