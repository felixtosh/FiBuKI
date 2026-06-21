"use client";

import { ColumnDef } from "@tanstack/react-table";
import { format } from "date-fns";
import {
  Tag,
  Loader2,
  CreditCard,
  Link2,
} from "lucide-react";
import { Transaction } from "@/types/transaction";
import { TransactionSource } from "@/types/source";
import { UserPartner, GlobalPartner } from "@/types/partner";
import { UserNoReceiptCategory, CategorySuggestion } from "@/types/no-receipt-category";
import { getCategoryTemplate } from "@/lib/data/no-receipt-category-templates";
import { Pill } from "@/components/ui/pill";
import { AmountMatchDisplay } from "@/components/ui/amount-match-display";
import { SortableHeader } from "@/components/ui/data-table";
import { PartnerPill } from "@/components/partners/partner-pill";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn, toDateSafe } from "@/lib/utils";
import { isRecentlyUpdated, MOTION } from "@/design-system";

export interface FileAmountData {
  totalAmount: number;
  fileCount: number;
  amounts: Array<{ amount: number; currency: string }>;
  hasExtractingFiles: boolean;
}

export interface TransactionColumnOptions {
  sources: TransactionSource[];
  userPartners?: UserPartner[];
  globalPartners?: GlobalPartner[];
  categories?: UserNoReceiptCategory[];
  categorySuggestions?: Map<string, CategorySuggestion>;
  fileAmountsMap?: Map<string, FileAmountData>;
  searchingTransactionIds?: Set<string>;
}

export function getTransactionColumns(
  sources: TransactionSource[],
  userPartners: UserPartner[] = [],
  globalPartners: GlobalPartner[] = [],
  categories: UserNoReceiptCategory[] = [],
  categorySuggestions?: Map<string, CategorySuggestion>,
  fileAmountsMap?: Map<string, FileAmountData>,
  searchingTransactionIds?: Set<string>
): ColumnDef<Transaction>[] {
  const sourceMap = new Map(sources.map((s) => [s.id, s]));
  const userPartnerMap = new Map(userPartners.map((p) => [p.id, p]));
  const globalPartnerMap = new Map(globalPartners.map((p) => [p.id, p]));
  const categoryMap = new Map(categories.map((c) => [c.id, c]));

  return [
    {
      accessorKey: "date",
      size: 100,
      header: ({ column }) => (
        <SortableHeader column={column}>Date</SortableHeader>
      ),
      cell: ({ row }) => {
        const date = row.getValue("date");
        const dateObj = toDateSafe(date);

        if (!dateObj) {
          return <span className="text-sm text-muted-foreground">—</span>;
        }

        const showTime = dateObj.getUTCHours() !== 0 || dateObj.getUTCMinutes() !== 0;
        return (
          <div>
            <p className="text-sm whitespace-nowrap">
              {format(dateObj, "MMM d, yyyy")}
            </p>
            {showTime && (
              <p className="text-sm text-muted-foreground">
                {format(dateObj, "HH:mm")}
              </p>
            )}
          </div>
        );
      },
    },
    {
      accessorKey: "amount",
      header: ({ column }) => (
        <SortableHeader column={column}>Amount</SortableHeader>
      ),
      cell: ({ row }) => {
        const amount = row.getValue("amount") as number;
        const currency = row.original.currency;
        const formatted = new Intl.NumberFormat("de-DE", {
          style: "currency",
          currency: currency || "EUR",
        }).format(amount / 100);

        return (
          <span
            className={cn(
              "text-sm tabular-nums whitespace-nowrap",
              amount < 0 ? "text-amount-negative" : "text-amount-positive"
            )}
          >
            {formatted}
          </span>
        );
      },
    },
    {
      accessorKey: "name",
      header: "Description",
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="text-sm truncate">{row.original.partner || "—"}</p>
          <p className="text-sm text-muted-foreground truncate">
            {row.getValue("name")}
          </p>
        </div>
      ),
    },
    {
      id: "assignedPartner",
      header: "Partner",
      cell: ({ row }) => {
        const { partnerId, partnerType, partnerMatchConfidence } = row.original;
        const serverSuggestions = row.original.partnerSuggestions || [];

        // Find top suggestion (first with a resolvable partner)
        let topSuggestionId: string | null = null;
        let topSuggestionType: "global" | "user" | null = null;
        let topSuggestionConfidence: number | null = null;
        for (const s of serverSuggestions) {
          const p = s.partnerType === "global"
            ? globalPartnerMap.get(s.partnerId)
            : userPartnerMap.get(s.partnerId);
          if (p) {
            topSuggestionId = s.partnerId;
            topSuggestionType = s.partnerType;
            topSuggestionConfidence = s.confidence;
            break;
          }
        }

        // Determine what to display: assigned partner wins, else top suggestion
        const isAssigned = !!partnerId;
        const displayId = partnerId || topSuggestionId;
        const displayType = isAssigned ? partnerType : topSuggestionType;

        if (!displayId) {
          return <span className="text-sm text-muted-foreground">—</span>;
        }

        const partner = displayType === "global"
          ? globalPartnerMap.get(displayId)
          : userPartnerMap.get(displayId);

        if (!partner) {
          return <span className="text-sm text-muted-foreground">—</span>;
        }

        const isSuggestion = !isAssigned;
        const recent = isRecentlyUpdated(row.original.updatedAt, MOTION.JUST_COMPLETED_THRESHOLD_MS);
        // Pop-in only when genuinely new: recently assigned AND different from what was showing
        const isNewPartner = isAssigned && recent && displayId !== topSuggestionId;

        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <PartnerPill
                key={displayId}
                name={partner.name}
                variant={isSuggestion ? "suggestion" : "default"}
                confidence={isAssigned ? (partnerMatchConfidence ?? undefined) : (topSuggestionConfidence ?? undefined)}
                matchedBy={isAssigned ? row.original.partnerMatchedBy : undefined}
                animate={isNewPartner}
              />
            </TooltipTrigger>
            {isSuggestion && (
              <TooltipContent>
                <p className="text-xs">Click row to confirm</p>
              </TooltipContent>
            )}
          </Tooltip>
        );
      },
    },
    {
      id: "file",
      header: "File",
      cell: ({ row }) => {
        const fileCount = row.original.fileIds?.length || 0;
        const hasFile = fileCount > 0;
        const categoryTemplateId = row.original.noReceiptCategoryTemplateId;
        const hasNoReceiptCategory = !!categoryTemplateId;
        const txId = row.original.id;
        const isSearching = searchingTransactionIds?.has(txId);

        // Show loading spinner when precision search is in progress
        if (isSearching && !hasFile) {
          return (
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span className="text-xs">Searching...</span>
            </div>
          );
        }

        if (hasFile) {
          const fileData = fileAmountsMap?.get(txId);
          // Use transaction/payment date for currency conversion
          const txDate = row.original.date?.toDate?.();
          return (
            <AmountMatchDisplay
              count={fileCount}
              countType="file"
              primaryAmount={row.original.amount}
              primaryCurrency={row.original.currency || "EUR"}
              secondaryAmounts={fileData?.amounts || []}
              conversionDate={txDate}
              isExtracting={fileData?.hasExtractingFiles}
            />
          );
        }

        if (hasNoReceiptCategory) {
          const template = getCategoryTemplate(categoryTemplateId);
          const label = template?.name || "No receipt";
          const categoryConfidence = row.original.noReceiptCategoryConfidence;
          const categoryMatchedBy = row.original.noReceiptCategoryMatchedBy;
          const recent = isRecentlyUpdated(row.original.updatedAt, MOTION.JUST_COMPLETED_THRESHOLD_MS);
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <Pill
                    label={label}
                    icon={Tag}
                    confidence={categoryConfidence ?? undefined}
                    matchedBy={categoryMatchedBy}
                    animate={recent}
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p className="text-xs">{template?.helperText || "No receipt required"}</p>
              </TooltipContent>
            </Tooltip>
          );
        }

        // Check for category suggestion
        const catSuggestion = categorySuggestions?.get(txId);
        if (catSuggestion) {
          const category = categoryMap.get(catSuggestion.categoryId);
          const label = category?.name || "Category";
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <div>
                  <Pill
                    label={label}
                    icon={Tag}
                    variant="suggestion"
                    confidence={catSuggestion.confidence}
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p className="text-xs">Click row to assign</p>
              </TooltipContent>
            </Tooltip>
          );
        }

        return (
          <span className="text-sm text-muted-foreground">—</span>
        );
      },
    },
    {
      id: "reconciliation",
      size: 40,
      header: "",
      cell: ({ row }) => {
        const suggestions = row.original.reconciliationSuggestions;
        const reconciledBy = row.original.reconciledByBankTxId;

        // Card transaction that's been reconciled
        if (reconciledBy) {
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center justify-center">
                  <Link2 className="h-3.5 w-3.5 text-green-600" />
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p className="text-xs">Reconciled with bank payment</p>
              </TooltipContent>
            </Tooltip>
          );
        }

        // Bank transaction with pending reconciliation suggestions
        if (suggestions && suggestions.length > 0) {
          const topSuggestion = suggestions[0];
          return (
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center justify-center">
                  <CreditCard className="h-3.5 w-3.5 text-blue-500 animate-pulse" />
                </div>
              </TooltipTrigger>
              <TooltipContent>
                <p className="text-xs font-medium">
                  {topSuggestion.chargeCount} card charge{topSuggestion.chargeCount !== 1 ? "s" : ""} detected
                </p>
                <p className="text-xs text-muted-foreground">
                  Click to review reconciliation
                </p>
              </TooltipContent>
            </Tooltip>
          );
        }

        return null;
      },
    },
    {
      accessorKey: "sourceId",
      size: 120,
      header: "Account",
      cell: ({ row }) => {
        const sourceId = row.getValue("sourceId") as string | undefined;
        if (!sourceId) {
          return <span className="text-muted-foreground">—</span>;
        }
        const source = sourceMap.get(sourceId);
        if (!source) {
          return <span className="text-muted-foreground text-xs">{sourceId.slice(0, 8)}...</span>;
        }
        return (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="text-sm truncate block">{source.name}</span>
            </TooltipTrigger>
            <TooltipContent>
              <p className="font-medium">{source.name}</p>
              <p className="text-xs text-muted-foreground font-mono">{source.iban}</p>
            </TooltipContent>
          </Tooltip>
        );
      },
    },
  ];
}
