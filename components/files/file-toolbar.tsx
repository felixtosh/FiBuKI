"use client";

import { useTranslations } from "next-intl";
import { ProgressCounter } from "@/components/ui/progress-counter";
import { Link2, ArrowUpDown, Trash2, Plus, Upload, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SearchButton } from "@/components/ui/search-button";
import { ChoiceFilter } from "@/components/ui/choice-filter";
import { DateRangeFilter } from "@/components/ui/date-range-filter";
import { OverflowFilterRow } from "@/components/ui/overflow-filter-row";
import { PartnerFilter } from "@/components/partners/partner-filter";
import { FileFilters } from "@/types/file";
import { UserPartner } from "@/types/partner";

interface FileToolbarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  filters: FileFilters;
  onFiltersChange: (filters: FileFilters) => void;
  userPartners?: UserPartner[];
  /** Number of files connected to at least one transaction */
  connectedCount?: number;
  /** Total number of files in current filter view */
  totalCount?: number;
  /** "New" menu: upload a file */
  onUploadClick?: () => void;
  /** "New" menu: create an invoice */
  onCreateInvoice?: () => void;
  /** An invoice is being created; the menu shows a spinner and is disabled */
  creatingInvoice?: boolean;
}

export function FileToolbar({
  searchValue,
  onSearchChange,
  filters,
  onFiltersChange,
  userPartners = [],
  connectedCount,
  totalCount,
  onUploadClick,
  onCreateInvoice,
  creatingInvoice,
}: FileToolbarProps) {

  const hasDateFilter = filters.extractedDateFrom || filters.extractedDateTo;







  const t = useTranslations("filters");
  // The Type chip is one choice across two stored fields: the deleted-files
  // view wins, since it changes which rows exist at all.
  const typeValue: "income" | "expense" | "not-invoice" | "undetermined" | "deleted" | undefined =
    filters.deletedOnly === true
      ? "deleted"
      : filters.amountType && filters.amountType !== "all"
        ? filters.amountType
        : undefined;

  // Show counter only when there are files
  const tProgress = useTranslations("progress");
  const showCounter = totalCount !== undefined && totalCount > 0;
  const tNew = useTranslations("files.new");

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b bg-background">
      {/* Left side: one line of filters; what does not fit goes behind
          More (#522). Search always stays. */}
      <OverflowFilterRow
        moreLabel={t("more")}
        panelTitle={t("panelTitle")}
        clearLabel={t("clearAll")}
        onClearAll={() =>
          onFiltersChange({
            ...filters,
            extractedDateFrom: undefined,
            extractedDateTo: undefined,
            amountType: undefined,
            deletedOnly: undefined,
            partnerIds: undefined,
            hasPartner: undefined,
            hasConnections: undefined,
          })
        }
        leading={
          <SearchButton
            value={searchValue}
            onSearch={onSearchChange}
            placeholder="Search files..."
          />
        }
        items={[
          {
            key: "date",
            active: Boolean(hasDateFilter),
            node: (
              <>
      <DateRangeFilter
        from={filters.extractedDateFrom}
        to={filters.extractedDateTo}
        onChange={(extractedDateFrom, extractedDateTo) =>
          onFiltersChange({ ...filters, extractedDateFrom, extractedDateTo })
        }
      />
              </>
            ),
          },
          {
            key: "type",
            active: typeValue !== undefined,
            node: (
              <>
      {/* Type: the Amount column's sign, not an invoice at all (#519), or
          not determined yet (direction or Document Type still open).
          The deleted-files view (#268) sits below a line, as the one bucket
          that is not a kind of document. */}
      <ChoiceFilter
        label={t("type.label")}
        icon={<ArrowUpDown className="h-4 w-4" />}
        allLabel={t("all")}
        value={typeValue}
        onChange={(value) =>
          onFiltersChange({
            ...filters,
            amountType: value === "deleted" ? undefined : value,
            deletedOnly: value === "deleted" ? true : undefined,
          })
        }
        options={[
          { value: "income", label: t("type.income") },
          { value: "expense", label: t("type.expense") },
          { value: "not-invoice", label: t("type.notInvoice") },
          { value: "undetermined", label: t("type.undetermined") },
          {
            value: "deleted",
            label: t("type.deleted"),
            icon: <Trash2 className="h-4 w-4" />,
            separated: true,
          },
        ]}
      />
              </>
            ),
          },
          {
            key: "partner",
            active: Boolean(filters.partnerIds?.length) || filters.hasPartner !== undefined,
            node: (
      <PartnerFilter
        userPartners={userPartners}
        partnerIds={filters.partnerIds}
        hasPartner={filters.hasPartner}
        onChange={(next) => onFiltersChange({ ...filters, ...next })}
      />
            ),
          },
          {
            key: "transactions",
            active: filters.hasConnections !== undefined,
            node: (
              <>
      {/* Transactions: the Transactions column (#519) */}
      <ChoiceFilter
        label={t("transactions.label")}
        icon={<Link2 className="h-4 w-4" />}
        allLabel={t("all")}
        value={
          filters.hasConnections === true
            ? "assigned"
            : filters.hasConnections === false
              ? "unassigned"
              : undefined
        }
        onChange={(value) =>
          onFiltersChange({
            ...filters,
            hasConnections: value === undefined ? undefined : value === "assigned",
          })
        }
        options={[
          { value: "assigned", label: t("assigned") },
          { value: "unassigned", label: t("unassigned") },
        ]}
      />
              </>
            ),
          },
        ]}
      />

      {/* Right side: counter */}
      {showCounter && (
        <ProgressCounter
          className="text-sm shrink-0"
          done={connectedCount ?? 0}
          total={totalCount ?? 0}
          explanation={
            <div className="space-y-1.5">
              <p>{tProgress("files", { done: connectedCount ?? 0, total: totalCount ?? 0 })}</p>
              <p className="text-muted-foreground">{tProgress("followsFilters")}</p>
            </div>
          }
        />
      )}

      {/* Right side: one primary "New" menu for the ways a File appears */}
      {(onUploadClick || onCreateInvoice) && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" className="shrink-0 gap-1" disabled={creatingInvoice}>
              {tNew("button")}
              {creatingInvoice ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {onUploadClick && (
              <DropdownMenuItem onSelect={onUploadClick}>
                <Upload className="h-4 w-4" />
                {tNew("upload")}
              </DropdownMenuItem>
            )}
            {onCreateInvoice && (
              <DropdownMenuItem onSelect={onCreateInvoice}>
                <FileText className="h-4 w-4" />
                {tNew("invoice")}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
