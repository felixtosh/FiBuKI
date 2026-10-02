"use client";

import { useMemo } from "react";
import { format } from "date-fns";
import { useTranslations } from "next-intl";
import { Ban, Building2, FileCheck, Flame, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FieldRow, PanelHeader } from "@/components/ui/detail-panel-primitives";
import { TaxFile } from "@/types/file";
import { fileDocumentAmount } from "@/lib/files/document-amount";
import { describeInvoiceDirection } from "@/lib/documents/document-type-presentation";
import { normalizeCurrencyForDisplay } from "@/functions/src/fx/currencyNormalization";
import { cn, toDateSafe } from "@/lib/utils";

interface FileBulkPanelProps {
  /**
   * "live" is the ordinary Files list; "deleted" is the deleted-files view
   * (#268), whose one bulk action is Purge — the only surface that has it.
   */
  mode?: "live" | "deleted";
  files: TaxFile[];
  onClearSelection: () => void;
  onAssignPartner: () => void;
  onMarkAsNotInvoice: () => void;
  onMarkAsInvoice: () => void;
  onDelete: () => void;
  onPurge?: () => void;
  isDeleting?: boolean;
  isPurging?: boolean;
  isUpdating?: boolean;
  isAssigningPartner?: boolean;
  progress?: { completed: number; total: number } | null;
}

function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(cents / 100);
}

/** A File's document amount with the sign its direction gives it, or null. */
function signedAmount(file: TaxFile): number | null {
  const amount = fileDocumentAmount(file);
  if (amount == null) return null;
  return describeInvoiceDirection(file.invoiceDirection).sign === "negative" ? -amount : amount;
}

/**
 * The detail sidebar while several Files are selected: a summary of the
 * selection on top (the Files themselves are highlighted in the list), the
 * bulk actions in the footer where a single File's actions sit, so a bulk
 * selection reads like any other selection.
 */
export function FileBulkPanel({
  mode = "live",
  files,
  onClearSelection,
  onAssignPartner,
  onMarkAsNotInvoice,
  onMarkAsInvoice,
  onDelete,
  onPurge,
  isDeleting = false,
  isPurging = false,
  isUpdating = false,
  isAssigningPartner = false,
  progress = null,
}: FileBulkPanelProps) {
  const t = useTranslations("files.bulk");
  const busy = isDeleting || isPurging || isUpdating || isAssigningPartner;

  const summary = useMemo(() => {
    const totals = new Map<string, number>();
    let withoutAmount = 0;
    let connected = 0;
    let withPartner = 0;
    let notInvoice = 0;
    let earliest: Date | null = null;
    let latest: Date | null = null;

    for (const file of files) {
      const amount = signedAmount(file);
      if (amount == null) {
        withoutAmount++;
      } else {
        const currency = normalizeCurrencyForDisplay(file.extractedCurrency);
        totals.set(currency, (totals.get(currency) ?? 0) + amount);
      }
      if (file.transactionIds?.length) connected++;
      if (file.partnerId) withPartner++;
      if (file.isNotInvoice) notInvoice++;
      const date = toDateSafe(file.extractedDate);
      if (date) {
        if (!earliest || date < earliest) earliest = date;
        if (!latest || date > latest) latest = date;
      }
    }

    return { totals: [...totals.entries()], withoutAmount, connected, withPartner, notInvoice, earliest, latest };
  }, [files]);

  const count = files.length;
  const dateRange =
    summary.earliest && summary.latest
      ? format(summary.earliest, "dd.MM.yyyy") === format(summary.latest, "dd.MM.yyyy")
        ? format(summary.earliest, "dd.MM.yyyy")
        : `${format(summary.earliest, "dd.MM.yyyy")} – ${format(summary.latest, "dd.MM.yyyy")}`
      : null;

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={t("title", { count })} onClose={onClearSelection} />

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-6">
          <div>
            {summary.totals.length > 0 && (
              <FieldRow label={t("total")}>
                <div className="flex flex-col items-end tabular-nums">
                  {summary.totals.map(([currency, cents]) => (
                    <span
                      key={currency}
                      className={cn(cents < 0 ? "text-amount-negative" : cents > 0 && "text-amount-positive")}
                    >
                      {formatMoney(cents, currency)}
                    </span>
                  ))}
                  {summary.withoutAmount > 0 && (
                    <span className="text-xs text-muted-foreground">
                      {t("withoutAmount", { count: summary.withoutAmount })}
                    </span>
                  )}
                </div>
              </FieldRow>
            )}
            {dateRange && (
              <FieldRow label={t("documentDates")}>
                <span className="block text-right">{dateRange}</span>
              </FieldRow>
            )}
            <FieldRow label={t("connected")}>
              <span className="block text-right">{t("ofCount", { part: summary.connected, count })}</span>
            </FieldRow>
            <FieldRow label={t("withPartner")}>
              <span className="block text-right">{t("ofCount", { part: summary.withPartner, count })}</span>
            </FieldRow>
            {summary.notInvoice > 0 && (
              <FieldRow label={t("notInvoice")}>
                <span className="block text-right">{t("ofCount", { part: summary.notInvoice, count })}</span>
              </FieldRow>
            )}
          </div>

        </div>
      </ScrollArea>

      <div className="p-4 border-t flex flex-col gap-2">
        {progress && (
          <p className="text-sm text-muted-foreground">
            {t(isAssigningPartner ? "assigningProgress" : "updatingProgress", {
              completed: progress.completed,
              total: progress.total,
            })}
          </p>
        )}
        {mode === "deleted" ? (
          onPurge && (
            <Button
              variant="outline"
              className="text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={onPurge}
              disabled={busy}
            >
              <Flame className="h-4 w-4 mr-2" />
              {isPurging ? t("purging") : t("purge", { count })}
            </Button>
          )
        ) : (
          <>
            <Button variant="outline" onClick={onAssignPartner} disabled={busy}>
              <Building2 className="h-4 w-4 mr-2" />
              {t("assignPartner")}
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" className="flex-1" onClick={onMarkAsInvoice} disabled={busy}>
                <FileCheck className="h-4 w-4 mr-2" />
                {t("markAsInvoice")}
              </Button>
              <Button variant="outline" className="flex-1" onClick={onMarkAsNotInvoice} disabled={busy}>
                <Ban className="h-4 w-4 mr-2" />
                {t("markAsNotInvoice")}
              </Button>
            </div>
            <Button
              variant="outline"
              className="text-destructive hover:text-destructive hover:bg-destructive/10"
              onClick={onDelete}
              disabled={busy}
            >
              <Trash2 className="h-4 w-4 mr-2" />
              {isDeleting ? t("deleting") : t("delete", { count })}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
