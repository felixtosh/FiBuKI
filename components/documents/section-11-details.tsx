"use client";

import { useState } from "react";
import { Check, Copy, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { DocumentTypeBadge } from "./document-type-badge";
import { TermGloss } from "./term-gloss";
import { cn } from "@/lib/utils";
import { useDocumentLabel } from "@/hooks/use-document-label";
import type { DocumentType, DocumentTypeBasis, Section11Element } from "@/types/file";
import {
  describeDocumentType,
  describeDocumentTypeBasis,
  describeMissingElements,
  describeSection11Consequence,
} from "@/lib/documents/document-type-presentation";

/**
 * The § 11 verdict (#205), and since #237 the one field that says what a File
 * is.
 *
 * `Section11MissingElements` is exported on its own because the transaction
 * surfaces list the same defects for the file behind a receipt-only
 * transaction, and the operator has to be able to name the same
 * elements in the same words in every place.
 */

interface Section11MissingElementsProps {
  documentType: DocumentType | null | undefined;
  /**
   * Widened to plain strings for the transaction surfaces (#207): the queue
   * unions the elements the stored records carry, and an element the backend
   * learns to report before this module learns to name it still has to
   * appear. `describeSection11Element` already falls back for those.
   */
  elements: Array<Section11Element | string> | null | undefined;
  /**
   * The paste-ready German supplier mail and the "ask the supplier" note. On
   * by default for the chase surfaces, whose job is chasing; the File detail
   * panel turns it off (#237), because there the user is reading a document.
   */
  withRequest?: boolean;
  /** The paragraph citations. Off on the File panel at rest (#237). */
  withCitations?: boolean;
  className?: string;
}

export function Section11MissingElements({
  documentType,
  elements,
  withRequest = true,
  withCitations = true,
  className,
}: Section11MissingElementsProps) {
  const [copied, setCopied] = useState(false);
  const labelFor = useDocumentLabel();
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
        {withRequest && missing.requestText && (
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
        {missing.items.map((item) => {
          const label = labelFor(item);
          return (
            <li key={item.element} className="text-sm leading-tight">
              <span>{label}</span>
              {/*
                The German on first use only (ADR-0007), and not at all when
                the interface already reads it.
              */}
              {item.german !== label && (
                <>
                  {" "}
                  <span className="text-xs text-muted-foreground">({item.german})</span>
                </>
              )}
              {withCitations && (
                <>
                  {" "}
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    {item.citation}
                  </span>
                </>
              )}
            </li>
          );
        })}
      </ul>
      {withRequest && missing.note && (
        <p className="text-xs text-muted-foreground">{missing.note}</p>
      )}
    </div>
  );
}

/**
 * What a File is, in the File detail panel's top block (#237, #513).
 *
 * The § 11 verdict is a dropdown beside Source and Uploaded, and its reasoning
 * (`Section11Reasoning`) sits behind the info button on the label. It used to
 * be its own section at the bottom of the panel, with a "Not a financial
 * document" switch that repeated what the type already says.
 *
 * The one control is the user's override, `isNotInvoice`, and it reaches "not
 * a financial document" and no further. There is deliberately no way to mark a
 * File as satisfying § 11: that is the judgement the classifier exists to
 * make, and a wrong override would be a wrong input VAT claim in the user's
 * own name. It calls the same two handlers as before, so what is stored does
 * not move.
 */
interface FileTypeControlProps {
  documentType: DocumentType | null | undefined;
  isNotInvoice: boolean | null | undefined;
  /** Classification is still running: the verdict is not in yet. */
  classifying?: boolean;
  disabled?: boolean;
  onMarkAsNotInvoice?: () => void;
  onUnmarkAsNotInvoice?: () => void;
}

export function FileTypeControl({
  documentType,
  isNotInvoice,
  classifying = false,
  disabled = false,
  onMarkAsNotInvoice,
  onUnmarkAsNotInvoice,
}: FileTypeControlProps) {
  const labelFor = useDocumentLabel();

  if (classifying) {
    return (
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Analyzing...
      </span>
    );
  }

  const markedNotADocument = isNotInvoice === true;
  return (
    <Select
      value={markedNotADocument ? "not-a-document" : "document"}
      onValueChange={(value) => {
        if (value === "not-a-document") onMarkAsNotInvoice?.();
        else onUnmarkAsNotInvoice?.();
      }}
      disabled={disabled || (markedNotADocument ? !onUnmarkAsNotInvoice : !onMarkAsNotInvoice)}
    >
      <SelectTrigger className="h-7 w-auto min-w-[140px] text-sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="document">{labelFor(describeDocumentType(documentType))}</SelectItem>
        <SelectItem value="not-a-document">Not a financial document</SelectItem>
      </SelectContent>
    </Select>
  );
}

/**
 * Why the File is what its Type says (#237): the consequence for input VAT
 * first, then the missing elements on a receipt, then the basis and the
 * paragraph citations. The content of the info button on the Type label.
 */
export function Section11Reasoning({
  documentType,
  basis,
  missingElements,
}: {
  documentType: DocumentType | null | undefined;
  basis: DocumentTypeBasis | null | undefined;
  missingElements: Section11Element[] | null | undefined;
}) {
  const { type: resolvedType } = describeDocumentType(documentType);
  const consequence = describeSection11Consequence(documentType, basis);
  const basisLines = describeDocumentTypeBasis(basis, documentType);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <h3 className="text-sm font-medium">§ 11 UStG</h3>
          <TermGloss term="section11" />
        </div>
        <DocumentTypeBadge type={documentType} withTooltip={false} />
      </div>

      <p className="text-sm text-muted-foreground" data-testid="section-11-consequence">
        {consequence}
        {(resolvedType === "invoice" || resolvedType === "receipt") && (
          <>
            {" "}
            <TermGloss term="vorsteuer" />
          </>
        )}
      </p>

      <Section11MissingElements
        documentType={documentType}
        elements={missingElements}
        withRequest={false}
        withCitations={false}
      />

      {/* The basis, so a borderline call can be judged instead of argued with. */}
      <dl className="space-y-1.5">
        {basisLines.map((line) => (
          <div key={line.id} className="flex items-start gap-3">
            <dt className="text-xs text-muted-foreground shrink-0 w-24">{line.label}</dt>
            <dd className="text-xs leading-snug flex-1">{line.text}</dd>
          </div>
        ))}
      </dl>
      {/* The audit reference for the defects listed above. */}
      <Section11CitationList documentType={documentType} elements={missingElements} />
    </div>
  );
}

/** The paragraph citations for the listed defects, behind the click. */
function Section11CitationList({
  documentType,
  elements,
}: {
  documentType: DocumentType | null | undefined;
  elements: Section11Element[] | null | undefined;
}) {
  const labelFor = useDocumentLabel();
  const missing = describeMissingElements(documentType, elements);
  if (missing.items.length === 0) return null;

  return (
    <dl className="space-y-1">
      {missing.items.map((item) => (
        <div key={item.element} className="flex items-start gap-3">
          <dt className="text-xs text-muted-foreground shrink-0 w-24">{labelFor(item)}</dt>
          <dd className="text-xs leading-snug flex-1">{item.citation}</dd>
        </div>
      ))}
    </dl>
  );
}
