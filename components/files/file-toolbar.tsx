"use client";

import { useTranslations } from "next-intl";
import { ProgressCounter } from "@/components/ui/progress-counter";
import { useState } from "react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { CalendarDays, Link2, ArrowUpDown, X, CalendarIcon, Trash2 } from "lucide-react";
import { SearchButton } from "@/components/ui/search-button";
import { ChoiceFilter } from "@/components/ui/choice-filter";
import { PartnerFilter } from "@/components/partners/partner-filter";
import { FileFilters } from "@/types/file";
import { cn } from "@/lib/utils";
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
}

export function FileToolbar({
  searchValue,
  onSearchChange,
  filters,
  onFiltersChange,
  userPartners = [],
  connectedCount,
  totalCount,
}: FileToolbarProps) {
  const [datePopoverOpen, setDatePopoverOpen] = useState(false);
  const [showFromCalendar, setShowFromCalendar] = useState(false);
  const [showToCalendar, setShowToCalendar] = useState(false);

  const hasDateFilter = filters.extractedDateFrom || filters.extractedDateTo;

  const handleDatePresetClick = (preset: string) => {
    const now = new Date();
    let extractedDateFrom: Date | undefined;
    let extractedDateTo: Date | undefined;

    switch (preset) {
      case "30d":
        extractedDateFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        extractedDateTo = now;
        break;
      case "3m":
        extractedDateFrom = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
        extractedDateTo = now;
        break;
      case "thisYear":
        extractedDateFrom = new Date(now.getFullYear(), 0, 1);
        extractedDateTo = now;
        break;
      case "lastYear":
        extractedDateFrom = new Date(now.getFullYear() - 1, 0, 1);
        extractedDateTo = new Date(now.getFullYear() - 1, 11, 31);
        break;
      default:
        extractedDateFrom = undefined;
        extractedDateTo = undefined;
    }

    onFiltersChange({ ...filters, extractedDateFrom, extractedDateTo });
    setDatePopoverOpen(false);
  };

  const clearDateFilter = (e: React.MouseEvent) => {
    e.stopPropagation();
    onFiltersChange({ ...filters, extractedDateFrom: undefined, extractedDateTo: undefined });
  };

  const getDateLabel = () => {
    if (!hasDateFilter) return "Date";
    if (filters.extractedDateFrom && filters.extractedDateTo) {
      return `${format(filters.extractedDateFrom, "MMM d")} - ${format(filters.extractedDateTo, "MMM d")}`;
    }
    if (filters.extractedDateFrom) return `From ${format(filters.extractedDateFrom, "MMM d")}`;
    if (filters.extractedDateTo) return `Until ${format(filters.extractedDateTo, "MMM d")}`;
    return "Date";
  };

  const t = useTranslations("filters");
  // The Type chip is one choice across two stored fields: the deleted-files
  // view wins, since it changes which rows exist at all.
  const typeValue: "income" | "expense" | "not-invoice" | "deleted" | undefined =
    filters.deletedOnly === true
      ? "deleted"
      : filters.amountType && filters.amountType !== "all"
        ? filters.amountType
        : undefined;

  // Show counter only when there are files
  const tProgress = useTranslations("progress");
  const showCounter = totalCount !== undefined && totalCount > 0;

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b bg-background">
      {/* Left side: filters */}
      <div className="flex items-center gap-2 flex-wrap flex-1">
        {/* Search button */}
        <SearchButton
          value={searchValue}
          onSearch={onSearchChange}
          placeholder="Search files..."
        />

      {/* Date filter (Invoice Date) */}
      <Popover open={datePopoverOpen} onOpenChange={setDatePopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            variant={hasDateFilter ? "secondary" : "outline"}
            size="sm"
            className="h-9 gap-2"
          >
            <CalendarDays className="h-4 w-4" />
            <span>{getDateLabel()}</span>
            {hasDateFilter && (
              <span
                role="button"
                tabIndex={0}
                onClick={clearDateFilter}
                onKeyDown={(e) => e.key === "Enter" && clearDateFilter(e as unknown as React.MouseEvent)}
                className="ml-1 hover:bg-muted rounded p-0.5 -mr-1 cursor-pointer"
              >
                <X className="h-3 w-3" />
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-4" align="start">
          <div className="space-y-4">
            {/* From/To date pickers on top */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">From</label>
                <Popover open={showFromCalendar} onOpenChange={setShowFromCalendar}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        "w-full justify-start text-left font-normal h-9",
                        !filters.extractedDateFrom && "text-muted-foreground"
                      )}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {filters.extractedDateFrom ? format(filters.extractedDateFrom, "PP") : "Pick date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={filters.extractedDateFrom}
                      onSelect={(date) => {
                        onFiltersChange({ ...filters, extractedDateFrom: date });
                        setShowFromCalendar(false);
                      }}
                      autoFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>

              <div className="space-y-1.5">
                <label className="text-xs font-medium text-muted-foreground">To</label>
                <Popover open={showToCalendar} onOpenChange={setShowToCalendar}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      className={cn(
                        "w-full justify-start text-left font-normal h-9",
                        !filters.extractedDateTo && "text-muted-foreground"
                      )}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {filters.extractedDateTo ? format(filters.extractedDateTo, "PP") : "Pick date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={filters.extractedDateTo}
                      onSelect={(date) => {
                        onFiltersChange({ ...filters, extractedDateTo: date });
                        setShowToCalendar(false);
                      }}
                      autoFocus
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </div>

            {/* Separator */}
            <div className="border-t" />

            {/* Quick presets as buttons */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Quick select</label>
              <div className="flex flex-wrap gap-1.5">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={() => handleDatePresetClick("all")}
                >
                  All time
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={() => handleDatePresetClick("30d")}
                >
                  30 days
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={() => handleDatePresetClick("3m")}
                >
                  3 months
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={() => handleDatePresetClick("thisYear")}
                >
                  This year
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  onClick={() => handleDatePresetClick("lastYear")}
                >
                  Last year
                </Button>
              </div>
            </div>
          </div>
        </PopoverContent>
      </Popover>

      {/* Type: the Amount column's sign, or not an invoice at all (#519).
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
          {
            value: "deleted",
            label: t("type.deleted"),
            icon: <Trash2 className="h-4 w-4" />,
            separated: true,
          },
        ]}
      />

      <PartnerFilter
        userPartners={userPartners}
        partnerIds={filters.partnerIds}
        hasPartner={filters.hasPartner}
        onChange={(next) => onFiltersChange({ ...filters, ...next })}
      />

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
      </div>

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
    </div>
  );
}
