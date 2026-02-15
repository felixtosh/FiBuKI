"use client";

import { ColumnDef } from "@tanstack/react-table";
import { format } from "date-fns";
import { Upload, Mail, Loader2 } from "lucide-react";
import { TaxFile } from "@/types/file";
import { UserPartner, GlobalPartner } from "@/types/partner";
import { PipelineId } from "@/types/automation";
import { SortableHeader, AutomationHeader } from "@/components/ui/data-table";
import { PartnerPill } from "@/components/partners/partner-pill";
import { AmountMatchDisplay } from "@/components/ui/amount-match-display";
import { cn, toDateSafe } from "@/lib/utils";
import { convertCurrency } from "@/lib/currency";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";

export interface TransactionAmountInfo {
  amount: number;
  currency: string;
}

// Map currency symbols to ISO codes
const CURRENCY_SYMBOL_MAP: Record<string, string> = {
  "€": "EUR",
  "$": "USD",
  "£": "GBP",
  "¥": "JPY",
  "CHF": "CHF",
  "Fr.": "CHF",
};

function normalizeCurrency(currency: string | null | undefined): string {
  if (!currency) return "EUR";
  // Already an ISO code
  if (/^[A-Z]{3}$/.test(currency)) return currency;
  // Try to map symbol
  return CURRENCY_SYMBOL_MAP[currency] || "EUR";
}

export function getFileColumns(
  userPartners: UserPartner[] = [],
  globalPartners: GlobalPartner[] = [],
  transactionAmountsMap?: Map<string, TransactionAmountInfo[]>,
  onAutomationClick?: (pipelineId: PipelineId) => void,
  searchingFileIds?: Set<string>
): ColumnDef<TaxFile>[] {
  const userPartnerMap = new Map(userPartners.map((p) => [p.id, p]));
  const globalPartnerMap = new Map(globalPartners.map((p) => [p.id, p]));

  return [
    {
      accessorKey: "uploadedAt",
      size: 100,
      header: ({ column }) => (
        <SortableHeader column={column}>Upload Date</SortableHeader>
      ),
      cell: ({ row }) => {
        const uploadedAt = row.getValue("uploadedAt");
        const dateObj = toDateSafe(uploadedAt);

        if (!dateObj) {
          return <span className="text-sm text-muted-foreground">—</span>;
        }

        const timeStr = format(dateObj, "HH:mm");
        const showTime = timeStr !== "00:00";

        return (
          <div>
            <p className="text-sm whitespace-nowrap">
              {format(dateObj, "MMM d, yyyy")}
            </p>
            {showTime && (
              <p className="text-xs text-muted-foreground">
                {timeStr}
              </p>
            )}
          </div>
        );
      },
    },
    {
      accessorKey: "fileName",
      header: "Filename",
      cell: ({ row }) => {
        const fileName = row.getValue("fileName") as string;
        const { classificationComplete, extractionComplete, isNotInvoice } = row.original;

        // Determine processing status
        let statusText: string | null = null;
        if (!classificationComplete) {
          statusText = "Analyzing...";
        } else if (!extractionComplete && !isNotInvoice) {
          statusText = "Parsing...";
        } else if (isNotInvoice) {
          statusText = "Not an invoice";
        }

        return (
          <div className="min-w-0">
            <p className="text-sm truncate">{fileName}</p>
            {statusText && (
              <p className="text-xs text-muted-foreground flex items-center gap-1">
                {(statusText === "Analyzing..." || statusText === "Parsing...") && (
                  <Loader2 className="h-3 w-3 animate-spin" />
                )}
                {statusText}
              </p>
            )}
          </div>
        );
      },
    },
    {
      accessorKey: "extractedDate",
      size: 100,
      header: ({ column }) => (
        <SortableHeader column={column}>Inv. Date</SortableHeader>
      ),
      cell: ({ row }) => {
        const extractedDate = row.original.extractedDate;
        const dateObj = toDateSafe(extractedDate);

        if (!dateObj) {
          return <span className="text-sm text-muted-foreground">—</span>;
        }

        const timeStr = format(dateObj, "HH:mm");
        const showTime = timeStr !== "00:00";

        return (
          <div>
            <p className="text-sm whitespace-nowrap">
              {format(dateObj, "MMM d, yyyy")}
            </p>
            {showTime && (
              <p className="text-xs text-muted-foreground">
                {timeStr}
              </p>
            )}
          </div>
        );
      },
    },
    {
      accessorKey: "extractedAmount",
      header: ({ column }) => (
        <SortableHeader column={column}>Amount</SortableHeader>
      ),
      cell: ({ row }) => {
        const amount = row.getValue("extractedAmount") as number | null | undefined;
        const currency = normalizeCurrency(row.original.extractedCurrency);
        const vatPercent = row.original.extractedVatPercent;
        const vatAmount = row.original.extractedVatAmount;
        const invoiceDirection = row.original.invoiceDirection;
        const extractedDate = row.original.extractedDate;

        if (amount == null) {
          return <span className="text-sm text-muted-foreground">—</span>;
        }

        // Apply sign based on direction (incoming = expense/negative, outgoing = income/positive)
        const signedAmount = invoiceDirection === "incoming" ? -(amount / 100) : amount / 100;
        const originalFormatted = new Intl.NumberFormat("de-DE", {
          style: "currency",
          currency,
        }).format(signedAmount);

        // Convert to EUR if currency differs - EUR becomes primary display
        let displayAmount = originalFormatted;
        let conversionInfo: { original: string; converted: string; rate: number; rateCurrency: string } | null = null;

        if (currency !== "EUR") {
          const dateForConversion = toDateSafe(extractedDate) || new Date();
          const conversion = convertCurrency(Math.abs(amount), currency, "EUR", dateForConversion);
          if (conversion) {
            const signedConverted = invoiceDirection === "incoming" ? -(conversion.amount / 100) : conversion.amount / 100;
            displayAmount = "~" + new Intl.NumberFormat("de-DE", {
              style: "currency",
              currency: "EUR",
            }).format(signedConverted);
            conversionInfo = {
              original: originalFormatted,
              converted: displayAmount,
              rate: conversion.rate,
              rateCurrency: currency,
            };
          }
        }

        const amountDisplay = (
          <div>
            <p
              className={cn(
                "text-sm tabular-nums whitespace-nowrap",
                signedAmount < 0 ? "text-amount-negative" : "text-amount-positive"
              )}
            >
              {displayAmount}
            </p>
            {vatPercent != null ? (
              <p className="text-xs text-muted-foreground">
                {vatPercent}% VAT
              </p>
            ) : vatAmount != null ? (
              <p className="text-xs text-muted-foreground tabular-nums">
                {new Intl.NumberFormat("de-DE", {
                  style: "currency",
                  currency,
                }).format(Math.abs(vatAmount) / 100)} VAT
              </p>
            ) : null}
          </div>
        );

        // Wrap in tooltip if currency was converted
        if (conversionInfo) {
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <div>{amountDisplay}</div>
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
      },
    },
    {
      id: "assignedPartner",
      header: () =>
        onAutomationClick ? (
          <AutomationHeader
            label="Partner"
            pipelineId="file-find-partner"
            onAutomationClick={onAutomationClick}
          />
        ) : (
          "Partner"
        ),
      cell: ({ row }) => {
        const {
          id: fileId,
          partnerId,
          partnerType,
          partnerMatchConfidence,
          partnerMatchedBy,
          extractionComplete,
          partnerMatchComplete,
          isNotInvoice,
        } = row.original;

        // Show searching state when AI search is in progress
        if (searchingFileIds?.has(fileId)) {
          return (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              Searching...
            </span>
          );
        }

        // Show assigned partner if exists
        if (partnerId) {
          const partner = partnerType === "global"
            ? globalPartnerMap.get(partnerId)
            : userPartnerMap.get(partnerId);
          return (
            <div className="min-w-0 overflow-hidden">
              <PartnerPill
                name={partner?.name || partnerId.slice(0, 8) + "..."}
                confidence={partnerMatchConfidence ?? undefined}
                matchedBy={partnerMatchedBy}
                partnerType={partnerType ?? undefined}
                className="max-w-full"
              />
            </div>
          );
        }

        // Show "Matching..." when extraction is done but partner match is in progress
        if (extractionComplete && !partnerMatchComplete && !isNotInvoice) {
          return (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              Matching...
            </span>
          );
        }

        return <span className="text-sm text-muted-foreground">—</span>;
      },
    },
    {
      id: "connections",
      size: 140,
      header: () =>
        onAutomationClick ? (
          <AutomationHeader
            label="Transactions"
            pipelineId="file-find-tx"
            onAutomationClick={onAutomationClick}
          />
        ) : (
          "Transactions"
        ),
      cell: ({ row }) => {
        const {
          id: fileId,
          transactionIds,
          extractedAmount,
          extractedCurrency,
          partnerMatchComplete,
          transactionMatchComplete,
          isNotInvoice,
        } = row.original;
        const count = transactionIds.length;

        // Show searching state when AI search is in progress (only when no transactions connected yet)
        if (searchingFileIds?.has(fileId) && count === 0) {
          return (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              Searching...
            </span>
          );
        }

        // Show connected count with amount matching info
        if (count > 0) {
          const txAmounts = transactionAmountsMap?.get(fileId) || [];
          const fileDate = row.original.extractedDate?.toDate?.() || undefined;
          return (
            <AmountMatchDisplay
              count={count}
              countType="tx"
              primaryAmount={extractedAmount ?? null}
              primaryCurrency={normalizeCurrency(extractedCurrency)}
              secondaryAmounts={txAmounts}
              conversionDate={fileDate}
            />
          );
        }

        // Show "Matching..." when partner match is done but transaction match is in progress
        if (partnerMatchComplete && !transactionMatchComplete && !isNotInvoice) {
          return (
            <span className="text-xs text-muted-foreground flex items-center gap-1">
              <Loader2 className="h-3 w-3 animate-spin" />
              Matching...
            </span>
          );
        }

        return <span className="text-sm text-muted-foreground">—</span>;
      },
    },
    {
      accessorKey: "sourceType",
      size: 80,
      header: "Source",
      cell: ({ row }) => {
        const sourceType = row.original.sourceType;

        if (sourceType?.startsWith("gmail")) {
          return (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Mail className="h-3.5 w-3.5" />
              <span>Gmail</span>
            </div>
          );
        }

        if (sourceType?.startsWith("email_inbound")) {
          return (
            <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
              <Mail className="h-3.5 w-3.5" />
              <span>Email</span>
            </div>
          );
        }

        return (
          <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
            <Upload className="h-3.5 w-3.5" />
            <span>Upload</span>
          </div>
        );
      },
    },
  ];
}
