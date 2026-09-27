"use client";

import { useId, useState } from "react";
import { Check, ChevronDown, Copy, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
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
 * surfaces and the chase queue list the same defects for the file behind a
 * receipt-only transaction, and the operator has to be able to name the same
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

interface Section11FieldProps {
  documentType: DocumentType | null | undefined;
  basis: DocumentTypeBasis | null | undefined;
  missingElements: Section11Element[] | null | undefined;
  /** The stored user override. An input to the classifier, never a rival verdict. */
  isNotInvoice: boolean | null | undefined;
  /** The File is still being classified; the verdict is not in yet. */
  classifying?: boolean;
  /** Blocks the control, e.g. while the File is re-extracted after an undo. */
  disabled?: boolean;
  onMarkAsNotInvoice?: () => void;
  onUnmarkAsNotInvoice?: () => void;
  className?: string;
}

/**
 * The § 11 field on the File detail panel (#237).
 *
 * At rest it says two things: the verdict, and one sentence that leads with
 * the consequence (can I deduct this) and follows with the reason. On a
 * receipt it also lists the missing elements, because that is the defect to
 * chase; an invoice and an unknown File list none.
 *
 * Everything explaining HOW the verdict was reached (basis, regime, heading,
 * zero-VAT reason, recipient, record quality, citations) is behind a click,
 * not a hover: it is a finding a user may need to act on, and hover is
 * unreachable on touch and invisible to a keyboard.
 *
 * The one control is the user's override, `isNotInvoice`, and it reaches "not
 * a financial document" and no further. There is deliberately no way to mark a
 * File as satisfying § 11: that is the judgement the classifier exists to
 * make, and a wrong override would be a wrong input VAT claim in the user's
 * own name. It calls the same two handlers the old Quick Info dropdown did, so
 * what is stored does not move.
 */
export function Section11Field({
  documentType,
  basis,
  missingElements,
  isNotInvoice,
  classifying = false,
  disabled = false,
  onMarkAsNotInvoice,
  onUnmarkAsNotInvoice,
  className,
}: Section11FieldProps) {
  const [expanded, setExpanded] = useState(false);
  const headingId = useId();
  const basisId = useId();
  const switchId = useId();

  const { type: resolvedType } = describeDocumentType(documentType);
  const consequence = describeSection11Consequence(documentType, basis);
  const basisLines = describeDocumentTypeBasis(basis, documentType);
  const markedNotADocument = isNotInvoice === true;
  const controlDisabled =
    disabled ||
    classifying ||
    (markedNotADocument ? !onUnmarkAsNotInvoice : !onMarkAsNotInvoice);

  return (
    <section aria-labelledby={headingId} className={cn("space-y-3", className)}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <h3 id={headingId} className="text-sm font-medium">
            § 11 UStG
          </h3>
          <TermGloss term="section11" />
        </div>
        {classifying ? (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" />
            Analyzing...
          </span>
        ) : (
          <DocumentTypeBadge type={documentType} withTooltip={false} />
        )}
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

      {/* A finding, so it stays at rest: only a receipt has one. */}
      <Section11MissingElements
        documentType={documentType}
        elements={missingElements}
        withRequest={false}
        withCitations={false}
      />

      <div className="flex items-center justify-between gap-3">
        <label htmlFor={switchId} className="text-sm">
          Not a financial document
        </label>
        <Switch
          id={switchId}
          checked={markedNotADocument}
          disabled={controlDisabled}
          onCheckedChange={(checked) => {
            if (checked) onMarkAsNotInvoice?.();
            else onUnmarkAsNotInvoice?.();
          }}
        />
      </div>

      <div>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={basisId}
          onClick={() => setExpanded((open) => !open)}
          className={cn(
            "inline-flex items-center gap-1 rounded text-xs text-muted-foreground",
            "hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          )}
        >
          How this was decided
          <ChevronDown
            className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")}
          />
        </button>

        {expanded && (
          <div id={basisId} className="mt-2 space-y-3">
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
        )}
      </div>
    </section>
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
