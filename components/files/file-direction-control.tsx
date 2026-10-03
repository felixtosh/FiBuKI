"use client";

import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { InfoPopover } from "@/components/ui/info-popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Loader2 } from "lucide-react";
import { useDocumentLabel } from "@/hooks/use-document-label";
import {
  describeDirectionReview,
  describeDocumentType,
  describeInvoiceDirection,
} from "@/lib/documents/document-type-presentation";
import { cn } from "@/lib/utils";
import type { TaxFile } from "@/types/file";
import type { InvoiceDirection } from "@/types/user-data";

/**
 * Type, one field for what a File is and which way it goes (#519): Income
 * (an outgoing invoice), Expense (an incoming one), or Not an invoice. The
 * same three words as the Files list's Type filter.
 *
 * Before the File is placed it reads "Queued" until an extraction worker
 * picks it up (#603), "Analyzing..." while classification runs, then "Not
 * determined" until its direction is known. Direction used to
 * be shown only as the sign of the amount, where `unknown` fell through to a
 * positive figure (#233), so "Not determined" is a value here, never a guess.
 *
 * Picking Income or Expense on a File marked not an invoice undoes the mark,
 * which re-extracts it; extraction then decides the direction.
 */
type FileKind = "outgoing" | "incoming" | "not-invoice" | "unknown";

export function FileKindControl({
  file,
  classifying = false,
  disabled = false,
  onDirectionChange,
  onMarkAsNotInvoice,
  onUnmarkAsNotInvoice,
}: {
  file: TaxFile;
  classifying?: boolean;
  disabled?: boolean;
  onDirectionChange?: (direction: InvoiceDirection) => void;
  onMarkAsNotInvoice?: () => void;
  onUnmarkAsNotInvoice?: () => void;
}) {
  const t = useTranslations("filters.type");
  const tDetail = useTranslations("files.detail");

  if (classifying) {
    const queued = !file.extractionComplete && !file.extractionStartedAt;
    return (
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        {tDetail(queued ? "queued" : "analyzing")}
      </span>
    );
  }

  const value: FileKind = file.isNotInvoice
    ? "not-invoice"
    : (describeInvoiceDirection(file.invoiceDirection).direction as InvoiceDirection);

  const pick = (next: FileKind) => {
    if (next === value || next === "unknown") return;
    if (next === "not-invoice") {
      onMarkAsNotInvoice?.();
    } else if (file.isNotInvoice) {
      onUnmarkAsNotInvoice?.();
    } else {
      onDirectionChange?.(next);
    }
  };

  return (
    <Select value={value} onValueChange={(next) => pick(next as FileKind)} disabled={disabled}>
      <SelectTrigger
        className={cn(
          "h-7 w-auto min-w-[140px] text-sm",
          value === "unknown" && "text-muted-foreground"
        )}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {value === "unknown" && (
          <SelectItem value="unknown" disabled>
            {tDetail("notDetermined")}
          </SelectItem>
        )}
        <SelectItem value="outgoing">{t("income")}</SelectItem>
        <SelectItem value="incoming">{t("expense")}</SelectItem>
        <SelectItem value="not-invoice">{t("notInvoice")}</SelectItem>
      </SelectContent>
    </Select>
  );
}

/**
 * Whether the VAT on an Expense File can be deducted (#519): the § 11 verdict
 * stated as its consequence. A full invoice allows it; a payment confirmation
 * alone does not; anything else is not determined yet.
 */
export function useVatDeductible(file: TaxFile): { text: string; tone: "yes" | "no" | "unknown" } {
  const t = useTranslations("files.detail");
  const type = describeDocumentType(file.documentType).type;
  if (type === "invoice") return { text: t("vatDeductibleYes"), tone: "yes" };
  if (type === "receipt") return { text: t("vatDeductibleNo"), tone: "no" };
  return { text: t("notDetermined"), tone: "unknown" };
}

/** Why the direction needs a look, behind the label; null when it does not. */
export function FileDirectionInfo({ file }: { file: TaxFile }) {
  const t = useTranslations("files.detail");
  const documentLabel = useDocumentLabel();
  const review = describeDirectionReview(file);
  if (!review) return null;

  return (
    <InfoPopover label={t("whyDirection")}>
      <div className="space-y-2">
        <Badge variant="outline" className="text-xs">
          {documentLabel(review)}
        </Badge>
        <p className="text-xs text-muted-foreground">
          {review.text}
          {review.suggestion ? ` ${review.suggestion}` : ""}
        </p>
      </div>
    </InfoPopover>
  );
}
