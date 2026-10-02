"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { format } from "date-fns";
import { RefreshCw, Search, Loader2, Pencil, X, Plus, Trash2 } from "lucide-react";
import { ShowMoreButton } from "@/components/ui/show-more-button";
import { TaxFile } from "@/types/file";
import { InvoiceDirection } from "@/types/user-data";
import { EditableExtractedFields } from "@/lib/operations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { cn, toDateSafe } from "@/lib/utils";
import { useEcbConverter } from "@/lib/currency";
import { useDocumentLabel } from "@/hooks/use-document-label";
import { InfoPopover } from "@/components/ui/info-popover";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  describeDirectionReview,
  describeForeignRecipient,
  describeRepairAmbiguity,
  describeInvoiceDirection,
} from "@/lib/documents/document-type-presentation";
import { fileDocumentAmount, fileDocumentVatAmount } from "@/lib/files/document-amount";
import { blocksSave, lineItemRowProblem, updateLineItemRow } from "@/lib/files/line-item-math";
import {
  ADDITIONAL_FIELD_KEYS,
  PAYMENT_METHODS,
  isAdditionalFieldKey,
  isPaymentMethod,
} from "@/types/extraction-fields";

// Consistent field row component (matching transaction-details.tsx)
// Uses container queries to stack vertically when panel is narrow (<340px)
function FieldRow({
  label,
  labelInfo,
  children,
  className,
  onClick,
  searchText,
  isEditing,
  editValue,
  onEditChange,
  inputType = "text",
  placeholder,
}: {
  label: string;
  /** Explanation for this field, one click away. See InfoPopover. */
  labelInfo?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  onClick?: (text: string) => void;
  searchText?: string;
  isEditing?: boolean;
  editValue?: string;
  onEditChange?: (value: string) => void;
  inputType?: "text" | "date" | "number";
  placeholder?: string;
}) {
  const isClickable = onClick && searchText && !isEditing;

  return (
    <div className={cn("flex items-baseline gap-4 field-row-responsive", className)}>
      <span className="text-sm text-muted-foreground shrink-0 w-28 field-row-label flex items-center gap-1">
        {label}
        {labelInfo}
      </span>
      {isEditing && onEditChange ? (
        <Input
          type={inputType}
          value={editValue ?? ""}
          onChange={(e) => onEditChange(e.target.value)}
          className="h-8 text-sm flex-1 field-row-value"
          placeholder={placeholder}
        />
      ) : isClickable ? (
        <button
          onClick={() => onClick(searchText)}
          className="text-sm text-left hover:text-primary hover:underline underline-offset-2 flex items-center gap-1 group field-row-value"
        >
          {children}
          <Search className="h-3 w-3 opacity-0 group-hover:opacity-50 transition-opacity" />
        </button>
      ) : (
        <span className="text-sm field-row-value">{children}</span>
      )}
    </div>
  );
}

interface FileExtractedInfoProps {
  file: TaxFile;
  onRetryExtraction?: () => void;
  isRetrying?: boolean;
  /** True when parsing is in progress (after user marked file as invoice) */
  isParsing?: boolean;
  /** Called when user clicks a field value to search for it */
  onFieldClick?: (searchText: string) => void;
  /** Called when user updates extracted fields */
  onUpdate?: (fields: EditableExtractedFields) => Promise<void>;
  /** True when update is in progress */
  isUpdating?: boolean;
}

/** Mirrors `parseCurrencyToCents` in lib/operations/file-ops.ts — the delta
 * shown here has to agree with what a save would actually compute. */
function parseAmountToCents(value: string): number | null {
  const normalized = value.trim().replace(",", ".");
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) : null;
}

export function FileExtractedInfo({ file, onRetryExtraction, isRetrying, isParsing, onFieldClick, onUpdate, isUpdating }: FileExtractedInfoProps) {
  const convert = useEcbConverter();
  const tx = useTranslations("files.extracted");
  const documentLabel = useDocumentLabel();
  const directionPresentation = describeInvoiceDirection(file.invoiceDirection);
  const directionReview = describeDirectionReview(file);
  const foreignRecipient = describeForeignRecipient(file.foreignRecipient);
  const repairAmbiguity = describeRepairAmbiguity(file);
  const [showMore, setShowMore] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  // Why the last save did not land, shown until the next attempt (#342).
  const [saveError, setSaveError] = useState<string | null>(null);
  const [editedFields, setEditedFields] = useState<EditableExtractedFields>({
    date: "",
    amount: "",
    tipAmount: "",
    tipNotPrinted: false,
    vatPercent: "",
    partner: "",
    vatId: "",
    iban: "",
    address: "",
    additionalFields: [],
    lineItems: [],
  });

  // Initialize edit fields from file data
  const startEditing = () => {
    const existingAdditional = (file.extractedAdditionalFields || []).map((f) => ({
      key: f.key,
      label: f.label,
      value: f.value,
    }));
    const existingLineItems = (file.extractedLineItems || []).map((item) => ({
      description: item.description,
      vatPercent: item.vatPercent != null ? item.vatPercent.toString() : "",
      vatAmount: item.vatAmount != null ? (item.vatAmount / 100).toFixed(2) : "",
      amount: (item.amount / 100).toFixed(2),
    }));

    const extractedDate = toDateSafe(file.extractedDate);
    setEditedFields({
      date: extractedDate ? format(extractedDate, "yyyy-MM-dd") : "",
      // The STORED total, not the row-derived display figure (#203): whatever
      // sits in this box goes back to the server as the person's correction,
      // and seeding it with a derivation stamped the derived value as
      // hand-corrected on every save of a file whose rows disagree with it.
      amount: file.extractedAmount != null ? (file.extractedAmount / 100).toString() : "",
      // #217: seeded from the stored figure so a printed Trinkgeld is not
      // cleared by a save that never touched the box.
      tipAmount: file.extractedTipAmount != null ? (file.extractedTipAmount / 100).toString() : "",
      // #310: seeded from the bound the last correction recorded, so re-saving
      // a tip that was accepted as unprinted does not re-measure it against a
      // document total it was never meant to fit inside.
      tipNotPrinted: file.extractedTipBound?.bound === "transaction",
      vatPercent: file.extractedVatPercent != null ? file.extractedVatPercent.toString() : "",
      partner: file.extractedPartner || "",
      vatId: file.extractedVatId || "",
      iban: file.extractedIban || "",
      address: file.extractedAddress || "",
      additionalFields: existingAdditional,
      lineItems: existingLineItems,
    });
    setSaveError(null);
    setIsEditing(true);
    setShowMore(true); // Expand to show all fields when editing
  };

  const cancelEditing = () => {
    setSaveError(null);
    setIsEditing(false);
  };

  // A refused correction keeps the editor open with what was typed, so it can
  // be fixed rather than retyped, and says why (#342). It used to close
  // regardless, which made a refused tip indistinguishable from one accepted
  // and then lost.
  const handleUpdate = async () => {
    if (!onUpdate) return;
    setSaveError(null);
    try {
      await onUpdate(editedFields);
    } catch (error) {
      const message = error instanceof Error ? error.message.trim() : "";
      setSaveError(message || "The correction could not be saved.");
      return;
    }
    setIsEditing(false);
  };

  const updateField = (field: keyof Omit<EditableExtractedFields, "additionalFields" | "lineItems">) => (value: string) => {
    setEditedFields((prev) => ({ ...prev, [field]: value }));
  };

  // Only the value is editable (#540): the key says what the field is, and a
  // legacy row's printed label is evidence, not something to retype.
  const updateAdditionalField = (index: number, newValue: string) => {
    setEditedFields((prev) => ({
      ...prev,
      additionalFields: prev.additionalFields.map((f, i) =>
        i === index ? { ...f, value: newValue } : f
      ),
    }));
  };

  // A new field is picked from the fixed vocabulary (#540), never named by
  // hand: a free label is how "Tischnummer" got into the record. The label
  // stored beside it is the field's name in the person's language, since
  // there is no printed wording to keep.
  const addAdditionalField = (key: string) => {
    if (!isAdditionalFieldKey(key)) return;
    setEditedFields((prev) => ({
      ...prev,
      additionalFields: [
        ...prev.additionalFields,
        { key, label: tx(`fields.${key}`), value: key === "paymentMethod" ? "other" : "" },
      ],
    }));
  };

  const removeAdditionalField = (index: number) => {
    setEditedFields((prev) => ({
      ...prev,
      additionalFields: prev.additionalFields.filter((_, i) => i !== index),
    }));
  };

  const updateLineItemField = (
    index: number,
    key: "description" | "vatPercent" | "vatAmount" | "amount",
    value: string
  ) => {
    // #540: the coupled box follows, so a row's three numbers always agree.
    setEditedFields((prev) => ({
      ...prev,
      lineItems: (prev.lineItems || []).map((item, i) =>
        i === index ? updateLineItemRow(item, key, value) : item
      ),
    }));
  };

  const addLineItem = () => {
    setEditedFields((prev) => ({
      ...prev,
      lineItems: [
        ...(prev.lineItems || []),
        {
          description: "",
          vatPercent: "",
          vatAmount: "",
          amount: "",
        },
      ],
    }));
  };

  const removeLineItem = (index: number) => {
    setEditedFields((prev) => ({
      ...prev,
      lineItems: (prev.lineItems || []).filter((_, i) => i !== index),
    }));
  };

  /**
   * The exit for a delta that will not close (#253). Some documents genuinely
   * do not add up — a printed rounding line, a handwritten correction, an
   * illegible row — and there is no override flag for that: clearing the
   * rows in one action lets the file fall through to the top-level rung
   * (`updateFileExtractedFields` sends `lineItems: null` for an empty array),
   * which the UVA already trusts.
   */
  const removeAllLineItems = () => {
    setEditedFields((prev) => ({ ...prev, lineItems: [] }));
  };

  const formatAmount = (amount: number | null | undefined, currency: string | null | undefined, direction?: string) => {
    if (amount == null) return "—";
    // Apply sign based on direction (incoming = expense/negative, outgoing =
    // income/positive). A document nothing places gets no sign at all (#233):
    // it used to fall through to positive, which is what income looks like.
    const signedAmount =
      describeInvoiceDirection(direction).sign === "negative" ? -(amount / 100) : amount / 100;
    return new Intl.NumberFormat("de-DE", {
      style: "currency",
      currency: currency || "EUR",
    }).format(signedAmount);
  };

  const formatDocumentAmount = (amount: number | null | undefined, currency: string | null | undefined) => {
    if (amount == null) return "—";
    return new Intl.NumberFormat("de-DE", {
      style: "currency",
      currency: currency || "EUR",
    }).format(amount / 100);
  };

  // Format amount with EUR conversion - EUR is always primary display
  const formatAmountWithConversion = (
    amount: number | null | undefined,
    currency: string | null | undefined,
    direction?: string,
    conversionDate?: Date
  ): {
    display: string;
    isNegative: boolean;
    conversionInfo: { original: string; converted: string; rate: number; rateCurrency: string } | null
  } => {
    if (amount == null) return { display: "—", isNegative: false, conversionInfo: null };

    const normalizedCurrency = (currency || "EUR").toUpperCase();
    const originalFormatted = formatAmount(amount, currency, direction);
    const isNegative = describeInvoiceDirection(direction).sign === "negative";

    // No conversion needed if already EUR
    if (normalizedCurrency === "EUR") {
      return { display: originalFormatted, isNegative, conversionInfo: null };
    }

    // Convert to EUR - EUR becomes primary display
    const dateForConversion = conversionDate || new Date();
    const conversion = convert(
      Math.abs(amount),
      normalizedCurrency,
      "EUR",
      dateForConversion
    );

    if (conversion) {
      const signedConverted = isNegative ? -(conversion.amount / 100) : conversion.amount / 100;
      const convertedStr = "~" + new Intl.NumberFormat("de-DE", {
        style: "currency",
        currency: "EUR",
      }).format(signedConverted);
      return {
        display: convertedStr,
        isNegative,
        conversionInfo: {
          original: originalFormatted,
          converted: convertedStr,
          rate: conversion.rate,
          rateCurrency: normalizedCurrency,
        }
      };
    }

    return { display: originalFormatted, isNegative, conversionInfo: null };
  };

  // Get raw search text directly - no fallbacks, only use extracted raw text
  // Only works with string fields, not entity objects (issuer/recipient)
  type StringRawFields = "date" | "amount" | "vatPercent" | "partner" | "vatId" | "iban" | "address" | "website";
  const getRawSearchText = (field: StringRawFields): string | undefined => {
    const value = file.extractedRaw?.[field];
    return typeof value === "string" ? value : undefined;
  };

  // Get additional fields
  const additionalFields = file.extractedAdditionalFields || [];
  const hasAdditionalFields = additionalFields.length > 0;
  const lineItems = file.extractedLineItems || [];
  const hasLineItems = lineItems.length > 0;
  const editedLineItems = editedFields.lineItems || [];
  const hasEditableLineItems = isEditing && editedLineItems.length > 0;
  const effectiveAmount = fileDocumentAmount(file);
  const rateGroups = file.extractedRateGroups || [];
  const hasRateGroups = rateGroups.length > 0;

  // The row editor's own delta (#253): the rows are the only editable side,
  // the document total is fixed at whatever the Amount box holds (that box
  // locks itself while these rows are non-empty), and the delta is just the
  // difference between the two, recomputed on every keystroke.
  const lineItemsSumCents = editedLineItems.reduce(
    (sum, item) => sum + (parseAmountToCents(item.amount) ?? 0),
    0
  );
  const documentTotalCents = parseAmountToCents(editedFields.amount);
  const lineItemsDeltaCents =
    documentTotalCents != null ? lineItemsSumCents - documentTotalCents : null;

  // #540: a row no rate can produce cannot be saved; the server would
  // replace its VAT anyway, so saving it would store something nobody typed.
  const lineItemProblems = editedLineItems.map((item) => lineItemRowProblem(item));
  const lineItemsBlockSave = isEditing && lineItemProblems.some((problem) => blocksSave(problem));

  // Keyed fields are named in the person's language; keyless ones are legacy
  // rows from before the vocabulary closed, shown apart under their printed
  // label so they read as what they are (#540).
  const keyedAdditionalFields = additionalFields.filter((field) => isAdditionalFieldKey(field.key));
  const legacyAdditionalFields = additionalFields.filter((field) => !isAdditionalFieldKey(field.key));
  const unusedFieldKeys = ADDITIONAL_FIELD_KEYS.filter(
    (key) => !editedFields.additionalFields.some((field) => field.key === key)
  );
  const fieldValueLabel = (key: string | undefined, value: string) =>
    key === "paymentMethod" && isPaymentMethod(value) ? tx(`paymentMethods.${value}`) : value;

  // Secondary fields (VAT ID, IBAN, Address) - shown in "Show more"
  const hasSecondaryFields = !!(
    file.extractedVatId || file.extractedIban || file.extractedAddress || file.extractedCountry
  );

  const vatTotal = fileDocumentVatAmount(file);

  const vatBreakdown = lineItems.reduce((acc, item) => {
    const key = item.vatPercent == null ? "unknown" : item.vatPercent.toString();
    const current = acc.get(key) || {
      label: item.vatPercent == null ? "Rate n/a" : `${item.vatPercent}%`,
      amount: 0,
      rate: item.vatPercent,
    };
    current.amount += item.vatAmount;
    acc.set(key, current);
    return acc;
  }, new Map<string, { label: string; amount: number; rate: number | null }>());

  const vatBreakdownRows = Array.from(vatBreakdown.values()).sort((a, b) => {
    if (a.rate == null) return 1;
    if (b.rate == null) return -1;
    return b.rate - a.rate;
  });

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium">Extracted Information</h3>
        <div className="flex items-center gap-1.5">
          {file.extractionComplete ? (
            // Extraction done - show result or error
            file.extractionError ? (
              <>
                <Badge variant="destructive">Error</Badge>
                {onRetryExtraction && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-destructive hover:text-destructive hover:bg-destructive/20"
                    onClick={onRetryExtraction}
                    disabled={isRetrying}
                  >
                    <RefreshCw className={cn("h-4 w-4", isRetrying && "animate-spin")} />
                    <span className="sr-only">Retry extraction</span>
                  </Button>
                )}
              </>
            ) : (
              <>
                <Badge variant="secondary" className="text-green-600 bg-green-50">
                  {file.extractionConfidence != null && `${file.extractionConfidence}%`}
                </Badge>
                {/*
                  Available on a clean extraction too (fork #74). An extraction
                  that returns a poor-but-non-erroring result — no line items,
                  no VAT — sets no error, so gating this on one hid the retry
                  from exactly the files that need it.
                */}
                {onRetryExtraction && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 text-muted-foreground"
                    onClick={onRetryExtraction}
                    disabled={isRetrying}
                    title="Re-run extraction"
                  >
                    <RefreshCw className={cn("h-4 w-4", isRetrying && "animate-spin")} />
                    <span className="sr-only">Re-run extraction</span>
                  </Button>
                )}
                {/* Edit/Close button */}
                {onUpdate && !file.isNotInvoice && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6"
                    onClick={isEditing ? cancelEditing : startEditing}
                  >
                    {isEditing ? (
                      <X className="h-4 w-4" />
                    ) : (
                      <Pencil className="h-4 w-4" />
                    )}
                    <span className="sr-only">{isEditing ? "Cancel editing" : "Edit fields"}</span>
                  </Button>
                )}
              </>
            )
          ) : file.classificationComplete && !file.isNotInvoice ? (
            // Classification done (is invoice), extraction in progress - show "Parsing..."
            <span className="flex items-center gap-1.5 text-muted-foreground text-sm">
              <Loader2 className="h-3 w-3 animate-spin" />
              Parsing...
            </span>
          ) : isParsing ? (
            // User override: treating as invoice, parsing in progress
            <span className="flex items-center gap-1.5 text-muted-foreground text-sm">
              <Loader2 className="h-3 w-3 animate-spin" />
              Parsing...
            </span>
          ) : null}
        </div>
      </div>

      {/* Extraction error message */}
      {file.extractionError && (
        <div className="text-sm text-destructive bg-destructive/10 p-2 rounded">
          {file.extractionError}
        </div>
      )}

      {/* Findings that change what the document is worth, before its figures */}
      {foreignRecipient && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 space-y-1">
          <Badge variant="outline" className="text-xs">
            {foreignRecipient.label}
          </Badge>
          <p className="text-xs text-muted-foreground">{foreignRecipient.text}</p>
        </div>
      )}

      {/* A silent rewrite of extracted text is a finding, so it keeps its box. */}
      {repairAmbiguity && (
        <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 space-y-1">
          <Badge variant="outline" className="text-xs">
            {repairAmbiguity.label}
          </Badge>
          <p className="text-xs text-muted-foreground">{repairAmbiguity.text}</p>
        </div>
      )}

      {/*
        Only a CONFLICT still gets a callout of its own. A conflict is a
        finding: the document contradicts a transaction it is attached to, one
        of the two is wrong, and it was audited as producing only true
        positives. "No direction was ever established" is not a finding, it is
        an explanation, and it applied to a large minority of a real file set —
        so as a permanent bordered box above the figures it was noise on most
        files. It now hangs off the Direction label's info icon, where it is
        one click from the field it is about.
      */}
      {directionReview && directionReview.reason === "conflict" && (
        <div
          className={cn(
            "rounded border p-2 space-y-1",
            directionReview.tone === "warning"
              ? "border-amber-500/40 bg-amber-500/10"
              : "border-border bg-muted/40"
          )}
        >
          <Badge variant="outline" className="text-xs">
            {documentLabel(directionReview)}
          </Badge>
          <p className="text-xs text-muted-foreground">
            {directionReview.text}
            {directionReview.suggestion ? ` ${directionReview.suggestion}` : ""}
          </p>
        </div>
      )}


      {/* Fields - only show for invoices (not-invoice toggle is in Quick Info now) */}
      {file.extractionComplete && !file.extractionError && !file.isNotInvoice && (
        <div className="space-y-2">
          {/* Primary fields - always visible */}
          <FieldRow
            label="Document Date"
            onClick={onFieldClick}
            searchText={getRawSearchText("date")}
            isEditing={isEditing}
            editValue={editedFields.date}
            onEditChange={updateField("date")}
            inputType="date"
          >
            {toDateSafe(file.extractedDate)
              ? format(toDateSafe(file.extractedDate)!, "MMM d, yyyy")
              : "—"}
          </FieldRow>

          {/* Amount - shows EUR (converted if needed), with tooltip for conversion details */}
          <FieldRow
            label="Amount"
            onClick={onFieldClick}
            searchText={getRawSearchText("amount")}
            isEditing={isEditing}
            editValue={editedFields.amount}
            onEditChange={hasEditableLineItems ? undefined : updateField("amount")}
            inputType="number"
            placeholder="Amount in EUR"
          >
            {(() => {
              const { display, isNegative, conversionInfo } = formatAmountWithConversion(
                effectiveAmount,
                file.extractedCurrency,
                file.invoiceDirection,
                toDateSafe(file.extractedDate) ?? undefined
              );

              const amountDisplay = (
                <span
                  className={cn(
                    "tabular-nums",
                    directionPresentation.sign === "unsigned"
                      ? "text-muted-foreground"
                      : isNegative
                        ? "text-amount-negative"
                        : "text-amount-positive"
                  )}
                  title={
                    directionPresentation.sign === "unsigned"
                      ? directionPresentation.summary
                      : undefined
                  }
                >
                  {display}
                </span>
              );

              if (conversionInfo) {
                return (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span>{amountDisplay}</span>
                    </TooltipTrigger>
                    <TooltipContent>
                      <p className="text-xs">
                        <span className="text-muted-foreground">Original:</span> {conversionInfo.original}
                      </p>
                      <p className="text-xs">
                        <span className="text-muted-foreground">Converted:</span> {conversionInfo.converted}
                      </p>
                      <p className="text-xs">
                        <span className="text-muted-foreground">Rate:</span> 1 {conversionInfo.rateCurrency} = {conversionInfo.rate.toFixed(4)} EUR
                      </p>
                    </TooltipContent>
                  </Tooltip>
                );
              }

              return amountDisplay;
            })()}
          </FieldRow>

          {/*
            Trinkgeld (#217). The tip a card terminal took and the Beleg never
            printed has no other writer: extraction can only transcribe what is
            on the page, so without this box the bank line stays larger than the
            document forever and the reconciliation refuses the file. Shown when
            there is one to show, and whenever the form is open.

            It sits BESIDE the amount above and is never taken out of it. On a
            document that printed its own tip the extractor has already stripped
            it from the total; on one that did not, the total IS the VAT base.
          */}
          {(isEditing || file.extractedTipAmount != null) && (
            <FieldRow
              label="Tip"
              isEditing={isEditing}
              editValue={editedFields.tipAmount}
              onEditChange={updateField("tipAmount")}
              inputType="number"
              placeholder="Trinkgeld in EUR"
            >
              {formatDocumentAmount(file.extractedTipAmount, file.extractedCurrency)}
            </FieldRow>
          )}

          {/*
            #310. A hand-set tip is bounded, and which total bounds it depends
            on something only the person knows: whether the document printed the
            tip at all. Ticking this measures it against the bank line instead
            of the invoice — which is the only way a 5,00 tip on a 3,00 coffee
            can be recorded, and still no way to record one larger than the
            payment itself.
          */}
          {isEditing && editedFields.tipAmount.trim() !== "" && (
            <div className="flex items-center gap-4 field-row-responsive">
              <span className="text-sm text-muted-foreground shrink-0 w-28 field-row-label" />
              <label className="flex items-center gap-2 text-sm field-row-value">
                <Checkbox
                  checked={editedFields.tipNotPrinted === true}
                  onCheckedChange={(checked) =>
                    setEditedFields((prev) => ({ ...prev, tipNotPrinted: checked === true }))
                  }
                />
                Not printed on the invoice
              </label>
            </div>
          )}

          <FieldRow
            label="VAT"
            onClick={onFieldClick}
            searchText={getRawSearchText("vatPercent")}
            isEditing={isEditing}
            editValue={editedFields.vatPercent}
            onEditChange={hasEditableLineItems ? undefined : updateField("vatPercent")}
            inputType="number"
            placeholder="VAT %"
          >
            {hasLineItems ? (
              file.extractedVatPercent != null ? (
                <span className="tabular-nums">
                  {file.extractedVatPercent}% ({formatDocumentAmount(vatTotal, file.extractedCurrency)})
                </span>
              ) : vatTotal != null ? (
                <div className="space-y-1">
                  <div className="tabular-nums">{formatDocumentAmount(vatTotal, file.extractedCurrency)}</div>
                  {vatBreakdownRows.map((row) => (
                    <div key={row.label} className="text-xs text-muted-foreground tabular-nums">
                      {row.label}: {formatDocumentAmount(row.amount, file.extractedCurrency)}
                    </div>
                  ))}
                </div>
              ) : (
                "—"
              )
            ) : file.extractedVatPercent != null ? (
              `${file.extractedVatPercent}%`
            ) : (
              "—"
            )}
          </FieldRow>

          <FieldRow
            label="Partner"
            onClick={onFieldClick}
            searchText={getRawSearchText("partner")}
            isEditing={isEditing}
            editValue={editedFields.partner}
            onEditChange={updateField("partner")}
            placeholder="Company name"
          >
            {file.extractedPartner || "—"}
          </FieldRow>

          {/* Show more toggle - only if there are secondary or additional fields (hide when editing since all are shown) */}
          {(hasSecondaryFields || hasAdditionalFields || hasLineItems || hasRateGroups) && !isEditing && (
            <ShowMoreButton
              expanded={showMore}
              onToggle={() => setShowMore(!showMore)}
              className="pt-1"
            />
          )}

          {/* Secondary and additional fields - collapsed by default, always shown when editing */}
          {(showMore || isEditing) && (
            <div className="space-y-2 pt-1">
              {(file.extractedVatId || isEditing) && (
                <FieldRow
                  label="VAT ID"
                  onClick={onFieldClick}
                  searchText={getRawSearchText("vatId")}
                  isEditing={isEditing}
                  editValue={editedFields.vatId}
                  onEditChange={updateField("vatId")}
                  placeholder="e.g., DE123456789"
                >
                  {file.extractedVatId || "—"}
                </FieldRow>
              )}

              {(file.extractedIban || isEditing) && (
                <FieldRow
                  label="IBAN"
                  onClick={onFieldClick}
                  searchText={getRawSearchText("iban")}
                  isEditing={isEditing}
                  editValue={editedFields.iban}
                  onEditChange={updateField("iban")}
                  placeholder="e.g., DE89370400440532013000"
                >
                  {file.extractedIban || "—"}
                </FieldRow>
              )}

              {(file.extractedAddress || isEditing) && (
                <FieldRow
                  label="Address"
                  onClick={onFieldClick}
                  searchText={getRawSearchText("address")}
                  isEditing={isEditing}
                  editValue={editedFields.address}
                  onEditChange={updateField("address")}
                  placeholder="Full address"
                >
                  {file.extractedAddress || "—"}
                </FieldRow>
              )}

              {file.extractedCountry && !isEditing && (
                <FieldRow label={tx("country")}>{file.extractedCountry}</FieldRow>
              )}

              {/*
                Additional fields (#252, #540): named by key in the person's
                language. Only the value is editable; a new field is picked
                from the fixed list, never named by hand.
              */}
              {isEditing ? (
                <>
                  {editedFields.additionalFields.map((field, index) => (
                    <div key={index} className="flex items-center gap-2">
                      <span className="text-sm text-muted-foreground w-28 shrink-0 truncate">
                        {isAdditionalFieldKey(field.key) ? tx(`fields.${field.key}`) : field.label}
                      </span>
                      {field.key === "paymentMethod" ? (
                        <Select
                          value={isPaymentMethod(field.value) ? field.value : "other"}
                          onValueChange={(value) => updateAdditionalField(index, value)}
                        >
                          <SelectTrigger className="h-8 text-sm flex-1">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            {PAYMENT_METHODS.map((method) => (
                              <SelectItem key={method} value={method}>
                                {tx(`paymentMethods.${method}`)}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : (
                        <Input
                          value={field.value}
                          onChange={(e) => updateAdditionalField(index, e.target.value)}
                          className="h-8 text-sm flex-1"
                          placeholder={tx("value")}
                        />
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 shrink-0 text-muted-foreground hover:text-destructive"
                        onClick={() => removeAdditionalField(index)}
                        aria-label={tx("removeField")}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                  {unusedFieldKeys.length > 0 && (
                    <Select value="" onValueChange={addAdditionalField}>
                      <SelectTrigger className="h-8 text-sm w-full">
                        <span className="flex items-center gap-2 text-muted-foreground">
                          <Plus className="h-4 w-4" />
                          {tx("addField")}
                        </span>
                      </SelectTrigger>
                      <SelectContent>
                        {unusedFieldKeys.map((key) => (
                          <SelectItem key={key} value={key}>
                            {tx(`fields.${key}`)}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                </>
              ) : (
                <>
                  {keyedAdditionalFields.map((field, index) => (
                    <FieldRow
                      key={`k-${index}`}
                      label={tx(`fields.${field.key}`)}
                      onClick={onFieldClick}
                      searchText={field.rawValue || field.value}
                    >
                      {fieldValueLabel(field.key, field.value)}
                    </FieldRow>
                  ))}
                  {legacyAdditionalFields.length > 0 && (
                    <div className="space-y-2 pt-1">
                      <div className="text-xs text-muted-foreground flex items-center gap-1">
                        {tx("legacyFields")}
                        <InfoPopover label={tx("legacyFields")}>{tx("legacyFieldsInfo")}</InfoPopover>
                      </div>
                      {legacyAdditionalFields.map((field, index) => (
                        <FieldRow
                          key={`l-${index}`}
                          label={field.label}
                          onClick={onFieldClick}
                          searchText={field.rawValue || field.value}
                        >
                          {field.value}
                        </FieldRow>
                      ))}
                    </div>
                  )}
                </>
              )}

              {/*
                The printed rate group block (#253). Read off the document,
                shown as printed so a human can compare it against the Beleg
                in one glance — and NOT editable: its authority comes from
                being transcribed, and a hand-typed block would be
                indistinguishable from a hallucinated one once stored. It
                renders independently of the line items below, since a
                document can carry one without the other.
              */}
              {hasRateGroups && (
                <div className="space-y-2 pt-2">
                  <div className="text-sm text-muted-foreground">Printed rate groups</div>
                  <div className="rounded border p-2 space-y-1">
                    {rateGroups.map((group, index) => (
                      <div key={index} className="flex items-center justify-between gap-2 text-xs tabular-nums">
                        <span className="font-medium">{group.rate}%</span>
                        <span className="text-muted-foreground">
                          Net {formatDocumentAmount(group.net, file.extractedCurrency)} · VAT{" "}
                          {formatDocumentAmount(group.vat, file.extractedCurrency)}
                        </span>
                        <span>{formatDocumentAmount(group.gross, file.extractedCurrency)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {(hasLineItems || isEditing) && (
                <div className="space-y-2 pt-2">
                  <div className="text-sm text-muted-foreground">{tx("lineItems.title")}</div>
                  {isEditing ? (
                    <div className="space-y-2">
                      {/*
                        The live delta (#253): sum of the rows against the
                        document total, which is fixed here — it is edited in
                        its own "Amount" field higher up the form, not in this
                        panel. Save is never gated on this reaching zero: a
                        restaurant Beleg with an unprinted tip makes the
                        document total the wrong number, and a hard gate would
                        refuse a correct itemisation.
                      */}
                      {hasEditableLineItems && (
                        <div className="rounded border p-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs tabular-nums">
                          <span className="text-muted-foreground">Sum of rows</span>
                          <span className="text-right">
                            {formatDocumentAmount(lineItemsSumCents, file.extractedCurrency)}
                          </span>
                          <span className="text-muted-foreground">Document total</span>
                          <span className="text-right">
                            {formatDocumentAmount(documentTotalCents, file.extractedCurrency)}
                          </span>
                          <span className={cn("font-medium", lineItemsDeltaCents ? "text-amber-600" : undefined)}>
                            Delta
                          </span>
                          <span
                            className={cn(
                              "text-right font-medium",
                              lineItemsDeltaCents ? "text-amber-600" : undefined
                            )}
                          >
                            {formatDocumentAmount(lineItemsDeltaCents, file.extractedCurrency)}
                          </span>
                        </div>
                      )}
                      {hasEditableLineItems && (
                        <p className="text-xs text-muted-foreground">{tx("lineItems.coupledHint")}</p>
                      )}
                      {editedLineItems.map((item, index) => (
                        <div
                          key={index}
                          className={cn(
                            "rounded border p-2 space-y-2",
                            blocksSave(lineItemProblems[index]) && "border-destructive"
                          )}
                        >
                          <Input
                            value={item.description}
                            onChange={(e) => updateLineItemField(index, "description", e.target.value)}
                            className="h-8 text-sm"
                            placeholder={tx("lineItems.description")}
                          />
                          <div className="grid grid-cols-2 gap-2">
                            <Input
                              value={item.vatPercent}
                              onChange={(e) => updateLineItemField(index, "vatPercent", e.target.value)}
                              className="h-8 text-sm"
                              placeholder={tx("lineItems.vatPercent")}
                              aria-label={tx("lineItems.vatPercent")}
                              inputMode="decimal"
                            />
                            <Input
                              value={item.vatAmount}
                              onChange={(e) => updateLineItemField(index, "vatAmount", e.target.value)}
                              className="h-8 text-sm"
                              placeholder={tx("lineItems.vatAmount")}
                              aria-label={tx("lineItems.vatAmount")}
                              inputMode="decimal"
                            />
                            <Input
                              value={item.amount}
                              onChange={(e) => updateLineItemField(index, "amount", e.target.value)}
                              className="h-8 text-sm col-span-2"
                              placeholder={tx("lineItems.grossAmount")}
                              aria-label={tx("lineItems.grossAmount")}
                              inputMode="decimal"
                            />
                          </div>
                          {lineItemProblems[index] && (
                            <p
                              className={cn(
                                "text-xs",
                                blocksSave(lineItemProblems[index]) ? "text-destructive" : "text-amber-600"
                              )}
                            >
                              {tx(`lineItems.problems.${lineItemProblems[index]}`)}
                            </p>
                          )}
                          <Button
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-muted-foreground hover:text-destructive"
                            onClick={() => removeLineItem(index)}
                          >
                            <Trash2 className="h-4 w-4 mr-1" />
                            {tx("lineItems.removeItem")}
                          </Button>
                        </div>
                      ))}
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          className="flex-1"
                          onClick={addLineItem}
                        >
                          <Plus className="h-4 w-4 mr-2" />
                          {tx("lineItems.addItem")}
                        </Button>
                        {/*
                          The exit for a delta that will not close (#253): some
                          documents genuinely do not add up, and there is no
                          override flag for that. Clearing every row in one
                          action is the whole answer — the file falls through
                          to the top-level rung instead.
                        */}
                        {editedLineItems.length > 0 && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="flex-1 text-muted-foreground hover:text-destructive"
                            onClick={removeAllLineItems}
                          >
                            <Trash2 className="h-4 w-4 mr-2" />
                            {tx("lineItems.removeAll")}
                          </Button>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {lineItems.map((item, index) => (
                        <div key={index} className="rounded border p-2">
                          <div className="text-sm">{item.description || "—"}</div>
                          <div className="text-xs text-muted-foreground flex flex-wrap gap-3 mt-1 tabular-nums">
                            <span>{tx("lineItems.vat", { rate: item.vatPercent != null ? `${item.vatPercent}%` : "—" })}</span>
                            <span>{tx("lineItems.amount", { amount: formatDocumentAmount(item.amount, file.extractedCurrency) })}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Why the last save was refused - same treatment as extractionError */}
          {isEditing && saveError && (
            <div role="alert" className="text-sm text-destructive bg-destructive/10 p-2 rounded">
              Not saved: {saveError}
            </div>
          )}

          {lineItemsBlockSave && (
            <div role="alert" className="text-sm text-destructive">
              {tx("lineItems.fixRows")}
            </div>
          )}

          {/* Update/Cancel buttons - shown when editing */}
          {isEditing && (
            <div className="flex gap-2 pt-3">
              <Button
                variant="outline"
                size="sm"
                onClick={cancelEditing}
                disabled={isUpdating}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                onClick={handleUpdate}
                disabled={isUpdating || lineItemsBlockSave}
              >
                {isUpdating ? (
                  <>
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    Updating...
                  </>
                ) : (
                  "Update"
                )}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
