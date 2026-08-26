"use client";

import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DocumentTypeBadge } from "./document-type-badge";
import { cn } from "@/lib/utils";
import type { DocumentType, DocumentTypeBasis, Section11Element } from "@/types/file";
import {
  describeDocumentType,
  describeDocumentTypeBasis,
  describeMissingElements,
} from "@/lib/documents/document-type-presentation";

/**
 * The § 11 verdict on file detail (#205): what the document is, why the
 * classifier said so, and which elements it does not show.
 *
 * `Section11MissingElements` is exported on its own because the transaction
 * surfaces list the same defects for the file behind a receipt-only
 * transaction, and the operator has to be able to name the same elements in
 * the same words in both places.
 */

interface Section11MissingElementsProps {
  documentType: DocumentType | null | undefined;
  elements: Section11Element[] | null | undefined;
  className?: string;
}

export function Section11MissingElements({
  documentType,
  elements,
  className,
}: Section11MissingElementsProps) {
  const [copied, setCopied] = useState(false);
  const missing = describeMissingElements(documentType, elements);

  if (missing.items.length === 0) return null;

  const handleCopy = async () => {
    if (!missing.requestText) return;
    await navigator.clipboard.writeText(missing.requestText);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className={cn("space-y-1.5", className)}>
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            "text-xs font-medium",
            missing.isDefect ? "text-amber-700 dark:text-amber-400" : "text-muted-foreground"
          )}
        >
          {missing.heading}
        </span>
        {missing.requestText && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-xs text-muted-foreground"
            onClick={handleCopy}
            title="Copy a German request naming these elements"
          >
            {copied ? <Check className="h-3 w-3 mr-1" /> : <Copy className="h-3 w-3 mr-1" />}
            {copied ? "Copied" : "Copy request"}
          </Button>
        )}
      </div>
      <ul className="space-y-1">
        {missing.items.map((item) => (
          <li key={item.element} className="text-sm leading-tight">
            <span>{item.label}</span>{" "}
            <span className="text-xs text-muted-foreground whitespace-nowrap">
              {item.citation}
            </span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted-foreground">{missing.note}</p>
    </div>
  );
}

interface DocumentTypeSectionProps {
  documentType: DocumentType | null | undefined;
  basis: DocumentTypeBasis | null | undefined;
  missingElements: Section11Element[] | null | undefined;
  className?: string;
}

export function DocumentTypeSection({
  documentType,
  basis,
  missingElements,
  className,
}: DocumentTypeSectionProps) {
  const presentation = describeDocumentType(documentType);
  const basisLines = describeDocumentTypeBasis(basis, documentType);

  return (
    <div className={cn("space-y-3", className)}>
      <div className="flex items-center justify-between gap-2">
        {/*
          Named for the statute, so it cannot be confused with the coarse
          invoice / not-invoice toggle in Quick Info above it.
        */}
        <h3 className="text-sm font-medium">§ 11 Document Type</h3>
        <DocumentTypeBadge type={documentType} withTooltip={false} />
      </div>

      <p className="text-sm text-muted-foreground">{presentation.summary}</p>

      {/* The basis, so a borderline call can be judged instead of argued with. */}
      <dl className="space-y-1.5">
        {basisLines.map((line) => (
          <div key={line.id} className="flex items-start gap-3">
            <dt className="text-xs text-muted-foreground shrink-0 w-24">{line.label}</dt>
            <dd className="text-xs leading-snug flex-1">{line.text}</dd>
          </div>
        ))}
      </dl>

      <Section11MissingElements
        documentType={documentType}
        elements={missingElements}
      />
    </div>
  );
}
