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
import { useDocumentLabel } from "@/hooks/use-document-label";
import {
  describeDirectionReview,
  describeInvoiceDirection,
  INVOICE_DIRECTIONS,
} from "@/lib/documents/document-type-presentation";
import { cn } from "@/lib/utils";
import type { TaxFile } from "@/types/file";
import type { InvoiceDirection } from "@/types/user-data";

/**
 * Direction (#233), in the File detail panel's top block beside Type (#513).
 *
 * Until this row existed the field was rendered only as the SIGN of the
 * amount, where `unknown` fell through to a positive figure, so an undirected
 * purchase read as income and nothing in the product said so. Editable
 * because the only other way to move it was to edit identity data and hope
 * the backfill picked the file up.
 */
export function FileDirectionControl({
  file,
  onDirectionChange,
}: {
  file: TaxFile;
  onDirectionChange?: (direction: InvoiceDirection) => void;
}) {
  const documentLabel = useDocumentLabel();
  const presentation = describeInvoiceDirection(file.invoiceDirection);

  if (!onDirectionChange) {
    return (
      <span className={cn(presentation.direction === "unknown" && "text-muted-foreground")}>
        {documentLabel(presentation)}
      </span>
    );
  }

  return (
    <Select
      value={presentation.direction}
      onValueChange={(value) => onDirectionChange(value as InvoiceDirection)}
    >
      <SelectTrigger className="h-7 w-auto min-w-[140px] text-sm">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {(Object.keys(INVOICE_DIRECTIONS) as InvoiceDirection[]).map((direction) => (
          <SelectItem key={direction} value={direction}>
            {documentLabel(INVOICE_DIRECTIONS[direction])}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
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
