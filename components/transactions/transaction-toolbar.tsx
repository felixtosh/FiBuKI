"use client";

/**
 * ## The filter row filters this table. Nothing else belongs in it
 *
 * Everything to the left of the counter narrows the rows below it: search, the
 * date range, status, type, partner. That is the contract a user learns in the
 * first minute, and it is what makes the row safe to click through.
 *
 * A control that navigates somewhere else breaks it. The chase-queue link used
 * to sit among the filter popovers and read as a filter that did not filter; it
 * now sits beside the score ring, which is where account-level summary and the
 * actions on it live.
 *
 * So: narrowing the table goes left. Saying something about the whole account,
 * or leaving for another surface, goes right, next to the ring.
 */

import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import {
  CalendarDays,
  CircleCheck,
  ArrowUpDown,
  X,
  CalendarIcon,
  Check,
  ReceiptText,
  FileCheck,
} from "lucide-react";
import { SearchButton } from "@/components/ui/search-button";
import { SearchInput } from "@/components/ui/search-input";
import { DocumentationState, TransactionFilters } from "@/types/transaction";
import {
  ALL_DOCUMENTATION_STATES,
  normalizeDocumentationStates,
} from "@/lib/filters/documentation-state-filter";
import { describeDocumentationState } from "@/lib/documents/document-type-presentation";
import { useDocumentLabel } from "@/hooks/use-document-label";
import { cn, formatCurrency } from "@/lib/utils";
import { MOTION } from "@/design-system";
import { UserPartner } from "@/types/partner";

interface TransactionToolbarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  filters: TransactionFilters;
  onFiltersChange: (filters: TransactionFilters) => void;
  importFileName?: string;
  userPartners?: UserPartner[];
  /** Number of transactions with file or no-receipt category assigned */
  assignedCount?: number;
  /** Total number of transactions in current filter view */
  totalCount?: number;
  /** Sum of amounts for filtered transactions (in cents) */
  filteredSum?: number;
  /** Completion percentage (0-100) for the progress ring */
  scorePercent?: number;
  /** Receipt-only transactions across the account, not the filtered view (#207) */
  chaseQueueCount?: number;
  /** Share of the filtered rows documented by a § 11 invoice, i.e. deductible. */
  deductiblePercent?: number;
}

/**
 * Documented, and of that, deductible.
 *
 * The outer arc is the old ring: rows carrying a file or a no-document
 * category. The inner arc is the share that is documented by an invoice that
 * satisfies § 11, which is the part that actually earns Vorsteuer.
 *
 * The gap between the two arcs is the chase queue, which is why the way into
 * that queue sits immediately beside this. Before, the same fact was a fifth
 * column on the table; here it is one mark that already existed, given a
 * second reading.
 */
function ScoreRing({
  percent,
  deductiblePercent,
}: {
  percent: number;
  deductiblePercent?: number;
}) {
  const radius = 8;
  const innerRadius = 5;
  const circumference = 2 * Math.PI * radius;
  const innerCircumference = 2 * Math.PI * innerRadius;
  const offset = circumference - (percent / 100) * circumference;
  const innerOffset =
    innerCircumference - ((deductiblePercent ?? 0) / 100) * innerCircumference;
  const color =
    percent >= 100
      ? "text-yellow-500"
      : percent >= 67
        ? "text-green-500"
        : percent >= 33
          ? "text-amber-500"
          : "text-red-500";

  return (
    <svg width="20" height="20" viewBox="0 0 20 20" className="flex-shrink-0">
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        className="text-muted/40"
      />
      <circle
        cx="10"
        cy="10"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeDasharray={circumference}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 10 10)"
        className={cn(color, "transition-[stroke-dashoffset] duration-500 ease-out")}
      />
      {deductiblePercent !== undefined && (
        <circle
          cx="10"
          cy="10"
          r={innerRadius}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeDasharray={innerCircumference}
          strokeDashoffset={innerOffset}
          strokeLinecap="round"
          transform="rotate(-90 10 10)"
          className="text-green-600/70 transition-[stroke-dashoffset] duration-500 ease-out"
        />
      )}
    </svg>
  );
}

export function TransactionToolbar({
  searchValue,
  onSearchChange,
  filters,
  onFiltersChange,
  importFileName,
  userPartners = [],
  assignedCount,
  totalCount,
  filteredSum,
  scorePercent,
  chaseQueueCount = 0,
  deductiblePercent,
}: TransactionToolbarProps) {
  const [datePopoverOpen, setDatePopoverOpen] = useState(false);
  const [statusPopoverOpen, setStatusPopoverOpen] = useState(false);
  const [typePopoverOpen, setTypePopoverOpen] = useState(false);
  const [partnerPopoverOpen, setPartnerPopoverOpen] = useState(false);
  const [documentationPopoverOpen, setDocumentationPopoverOpen] = useState(false);
  const documentLabel = useDocumentLabel();
  const [partnerSearch, setPartnerSearch] = useState("");
  const [showFromCalendar, setShowFromCalendar] = useState(false);
  const [showToCalendar, setShowToCalendar] = useState(false);

  // Counter bump animation when assignedCount changes
  const prevAssignedRef = useRef(assignedCount);
  const [counterBumping, setCounterBumping] = useState(false);
  useEffect(() => {
    if (assignedCount !== undefined && prevAssignedRef.current !== undefined &&
        assignedCount !== prevAssignedRef.current) {
      queueMicrotask(() => setCounterBumping(true));
      const timer = setTimeout(() => setCounterBumping(false), MOTION.COUNTER_BUMP_DURATION_MS);
      prevAssignedRef.current = assignedCount;
      return () => clearTimeout(timer);
    }
    prevAssignedRef.current = assignedCount;
  }, [assignedCount]);

  const hasDateFilter = filters.dateFrom || filters.dateTo;
  const hasStatusFilter = filters.isComplete !== undefined;
  const hasAmountFilter = filters.amountType && filters.amountType !== "all";
  const selectedPartnerIds = filters.partnerIds || [];
  const hasPartnerFilter = selectedPartnerIds.length > 0;
  // #249: undefined is "all five", the default.
  const selectedDocumentationStates = filters.documentationStates ?? ALL_DOCUMENTATION_STATES;
  const hasDocumentationFilter = filters.documentationStates !== undefined;

  const handleDatePresetClick = (preset: string) => {
    const now = new Date();
    let dateFrom: Date | undefined;
    let dateTo: Date | undefined;

    switch (preset) {
      case "30d":
        dateFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        dateTo = now;
        break;
      case "3m":
        dateFrom = new Date(now.getFullYear(), now.getMonth() - 3, now.getDate());
        dateTo = now;
        break;
      case "thisYear":
        dateFrom = new Date(now.getFullYear(), 0, 1);
        dateTo = now;
        break;
      case "lastYear":
        dateFrom = new Date(now.getFullYear() - 1, 0, 1);
        dateTo = new Date(now.getFullYear() - 1, 11, 31);
        break;
      default:
        dateFrom = undefined;
        dateTo = undefined;
    }

    onFiltersChange({ ...filters, dateFrom, dateTo });
    setDatePopoverOpen(false);
  };

  const clearImportFilter = () => {
    onFiltersChange({ ...filters, importId: undefined });
  };

  const clearDateFilter = (e: React.MouseEvent) => {
    e.stopPropagation();
    onFiltersChange({ ...filters, dateFrom: undefined, dateTo: undefined });
  };

  const clearStatusFilter = (e: React.MouseEvent) => {
    e.stopPropagation();
    onFiltersChange({ ...filters, isComplete: undefined });
  };

  const clearAmountFilter = (e: React.MouseEvent) => {
    e.stopPropagation();
    onFiltersChange({ ...filters, amountType: undefined });
  };

  const clearPartnerFilter = (e: React.MouseEvent) => {
    e.stopPropagation();
    onFiltersChange({ ...filters, partnerIds: undefined });
  };

  const clearDocumentationFilter = (e: React.MouseEvent) => {
    e.stopPropagation();
    onFiltersChange({ ...filters, documentationStates: undefined });
  };

  const toggleDocumentationState = (state: DocumentationState) => {
    const next = selectedDocumentationStates.includes(state)
      ? selectedDocumentationStates.filter((s) => s !== state)
      : [...selectedDocumentationStates, state];
    onFiltersChange({ ...filters, documentationStates: normalizeDocumentationStates(next) });
  };

  const documentationLabel = !hasDocumentationFilter
    ? "Documentation"
    : selectedDocumentationStates.length === 1
      ? documentLabel(describeDocumentationState(selectedDocumentationStates[0]))
      : `Documentation (${selectedDocumentationStates.length})`;

  const getDateLabel = () => {
    if (!hasDateFilter) return "Date";
    if (filters.dateFrom && filters.dateTo) {
      return `${format(filters.dateFrom, "MMM d")} - ${format(filters.dateTo, "MMM d")}`;
    }
    if (filters.dateFrom) return `From ${format(filters.dateFrom, "MMM d")}`;
    if (filters.dateTo) return `Until ${format(filters.dateTo, "MMM d")}`;
    return "Date";
  };

  const getStatusLabel = () => {
    if (filters.isComplete === true) return "Assigned";
    if (filters.isComplete === false) return "Unassigned";
    return "Status";
  };

  const getAmountLabel = () => {
    if (filters.amountType === "income") return "Income";
    if (filters.amountType === "expense") return "Expenses";
    return "Type";
  };

  const partnerNameMap = new Map(userPartners.map((partner) => [partner.id, partner.name]));
  const selectedPartnerNames = selectedPartnerIds
    .map((id) => partnerNameMap.get(id))
    .filter(Boolean) as string[];
  const partnerLabel = hasPartnerFilter
    ? selectedPartnerNames.length === 1
      ? selectedPartnerNames[0]
      : `Partner (${selectedPartnerIds.length})`
    : "Partner";

  const filteredPartners = userPartners.filter((partner) => {
    if (!partnerSearch.trim()) return true;
    const search = partnerSearch.toLowerCase();
    return (
      partner.name.toLowerCase().includes(search) ||
      partner.aliases?.some((alias) => alias.toLowerCase().includes(search)) ||
      partner.vatId?.toLowerCase().includes(search) ||
      partner.website?.toLowerCase().includes(search)
    );
  });

  const togglePartner = (partnerId: string) => {
    const next = new Set(selectedPartnerIds);
    if (next.has(partnerId)) {
      next.delete(partnerId);
    } else {
      next.add(partnerId);
    }
    const nextIds = Array.from(next);
    onFiltersChange({ ...filters, partnerIds: nextIds.length > 0 ? nextIds : undefined });
  };

  // Show counter only when there are transactions
  const showCounter = totalCount !== undefined && totalCount > 0;

  return (
    <div className="grid grid-cols-[1fr_minmax(0,auto)] gap-2 px-4 py-2 border-b bg-background items-start">
      {/* Filters - takes available space */}
      <div className="flex items-center gap-2 flex-wrap min-w-0">
        <SearchButton
          value={searchValue}
          onSearch={onSearchChange}
          placeholder="Search transactions..."
        />

      {/* Date filter */}
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
                        !filters.dateFrom && "text-muted-foreground"
                      )}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {filters.dateFrom ? format(filters.dateFrom, "PP") : "Pick date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={filters.dateFrom}
                      onSelect={(date) => {
                        onFiltersChange({ ...filters, dateFrom: date });
                        setShowFromCalendar(false);
                      }}
                      initialFocus
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
                        !filters.dateTo && "text-muted-foreground"
                      )}
                    >
                      <CalendarIcon className="mr-2 h-4 w-4" />
                      {filters.dateTo ? format(filters.dateTo, "PP") : "Pick date"}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-auto p-0" align="start">
                    <Calendar
                      mode="single"
                      selected={filters.dateTo}
                      onSelect={(date) => {
                        onFiltersChange({ ...filters, dateTo: date });
                        setShowToCalendar(false);
                      }}
                      initialFocus
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

      {/* Status filter (assigned = has file or no-receipt category) */}
      <Popover open={statusPopoverOpen} onOpenChange={setStatusPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            variant={hasStatusFilter ? "secondary" : "outline"}
            size="sm"
            className="h-9 gap-2"
          >
            <CircleCheck className="h-4 w-4" />
            <span>{getStatusLabel()}</span>
            {hasStatusFilter && (
              <span
                role="button"
                tabIndex={0}
                onClick={clearStatusFilter}
                onKeyDown={(e) => e.key === "Enter" && clearStatusFilter(e as unknown as React.MouseEvent)}
                className="ml-1 hover:bg-muted rounded p-0.5 -mr-1 cursor-pointer"
              >
                <X className="h-3 w-3" />
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-2" align="start">
          <div className="flex flex-col gap-1">
            <Button
              variant={filters.isComplete === undefined ? "secondary" : "ghost"}
              size="sm"
              className="justify-start h-8"
              onClick={() => {
                onFiltersChange({ ...filters, isComplete: undefined });
                setStatusPopoverOpen(false);
              }}
            >
              All
            </Button>
            <Button
              variant={filters.isComplete === true ? "secondary" : "ghost"}
              size="sm"
              className="justify-start h-8"
              onClick={() => {
                onFiltersChange({ ...filters, isComplete: true });
                setStatusPopoverOpen(false);
              }}
            >
              Assigned
            </Button>
            <Button
              variant={filters.isComplete === false ? "secondary" : "ghost"}
              size="sm"
              className="justify-start h-8"
              onClick={() => {
                onFiltersChange({ ...filters, isComplete: false });
                setStatusPopoverOpen(false);
              }}
            >
              Unassigned
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      {/*
        Documentation State filter (#249). Multi-select with every state
        checked by default, unlike the single-select chips around it: the
        useful questions here are often exclusions. Labels are the badge's own
        (describeDocumentationState), so one state never reads two ways.
        It sits beside Status and does not replace it: Status says whether
        anything is attached, this says whether what is attached is enough.
      */}
      <Popover open={documentationPopoverOpen} onOpenChange={setDocumentationPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            variant={hasDocumentationFilter ? "secondary" : "outline"}
            size="sm"
            className="h-9 gap-2"
          >
            <FileCheck className="h-4 w-4" />
            <span>{documentationLabel}</span>
            {hasDocumentationFilter && (
              <span
                role="button"
                tabIndex={0}
                aria-label="Clear documentation filter"
                onClick={clearDocumentationFilter}
                onKeyDown={(e) => e.key === "Enter" && clearDocumentationFilter(e as unknown as React.MouseEvent)}
                className="ml-1 hover:bg-muted rounded p-0.5 -mr-1 cursor-pointer"
              >
                <X className="h-3 w-3" />
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-2" align="start">
          <div className="flex flex-col gap-1" role="menu">
            {ALL_DOCUMENTATION_STATES.map((state) => {
              const checked = selectedDocumentationStates.includes(state);
              const presentation = describeDocumentationState(state);
              return (
                <button
                  key={state}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={checked}
                  title={presentation.summary}
                  onClick={() => toggleDocumentationState(state)}
                  className={cn(
                    "w-full text-left flex items-center gap-2 rounded px-2 py-1.5 text-sm",
                    checked ? "bg-muted" : "hover:bg-muted/50"
                  )}
                >
                  <span
                    className={cn(
                      "h-4 w-4 rounded border flex items-center justify-center",
                      checked ? "border-primary text-primary" : "border-muted-foreground/40 text-transparent"
                    )}
                  >
                    <Check className="h-3 w-3" />
                  </span>
                  <span className="whitespace-nowrap">{documentLabel(presentation)}</span>
                </button>
              );
            })}
          </div>
        </PopoverContent>
      </Popover>

      {/* Amount type filter */}
      <Popover open={typePopoverOpen} onOpenChange={setTypePopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            variant={hasAmountFilter ? "secondary" : "outline"}
            size="sm"
            className="h-9 gap-2"
          >
            <ArrowUpDown className="h-4 w-4" />
            <span>{getAmountLabel()}</span>
            {hasAmountFilter && (
              <span
                role="button"
                tabIndex={0}
                onClick={clearAmountFilter}
                onKeyDown={(e) => e.key === "Enter" && clearAmountFilter(e as unknown as React.MouseEvent)}
                className="ml-1 hover:bg-muted rounded p-0.5 -mr-1 cursor-pointer"
              >
                <X className="h-3 w-3" />
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-2" align="start">
          <div className="flex flex-col gap-1">
            <Button
              variant={!filters.amountType || filters.amountType === "all" ? "secondary" : "ghost"}
              size="sm"
              className="justify-start h-8"
              onClick={() => {
                onFiltersChange({ ...filters, amountType: undefined });
                setTypePopoverOpen(false);
              }}
            >
              All
            </Button>
            <Button
              variant={filters.amountType === "income" ? "secondary" : "ghost"}
              size="sm"
              className="justify-start h-8"
              onClick={() => {
                onFiltersChange({ ...filters, amountType: "income" });
                setTypePopoverOpen(false);
              }}
            >
              Income
            </Button>
            <Button
              variant={filters.amountType === "expense" ? "secondary" : "ghost"}
              size="sm"
              className="justify-start h-8"
              onClick={() => {
                onFiltersChange({ ...filters, amountType: "expense" });
                setTypePopoverOpen(false);
              }}
            >
              Expenses
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      {/* Partner filter */}
      <Popover open={partnerPopoverOpen} onOpenChange={setPartnerPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            variant={hasPartnerFilter ? "secondary" : "outline"}
            size="sm"
            className="h-9 gap-2"
          >
            <span>{partnerLabel}</span>
            {hasPartnerFilter && (
              <span
                role="button"
                tabIndex={0}
                onClick={clearPartnerFilter}
                onKeyDown={(e) => e.key === "Enter" && clearPartnerFilter(e as unknown as React.MouseEvent)}
                className="ml-1 hover:bg-muted rounded p-0.5 -mr-1 cursor-pointer"
              >
                <X className="h-3 w-3" />
              </span>
            )}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-72 p-3" align="start">
          <div className="space-y-3">
            <SearchInput
              placeholder="Search partners..."
              value={partnerSearch}
              onChange={setPartnerSearch}
            />
            <div className="max-h-56 overflow-y-auto space-y-1">
              {filteredPartners.length === 0 ? (
                <p className="text-xs text-muted-foreground py-2 text-center">No partners found</p>
              ) : (
                filteredPartners.map((partner) => {
                  const checked = selectedPartnerIds.includes(partner.id);
                  return (
                    <button
                      key={partner.id}
                      type="button"
                      onClick={() => togglePartner(partner.id)}
                      className={cn(
                        "w-full text-left flex items-center gap-2 rounded px-2 py-1.5 text-sm",
                        checked ? "bg-muted" : "hover:bg-muted/50"
                      )}
                    >
                      <span
                        className={cn(
                          "h-4 w-4 rounded border flex items-center justify-center",
                          checked ? "border-primary text-primary" : "border-muted-foreground/40 text-transparent"
                        )}
                      >
                        <Check className="h-3 w-3" />
                      </span>
                      <span className="truncate">{partner.name}</span>
                    </button>
                  );
                })
              )}
            </div>
          </div>
        </PopoverContent>
      </Popover>


        {/* Import filter badge (if active) */}
        {filters.importId && (
          <Badge variant="secondary" className="gap-1 h-8">
            Import: {importFileName || "Selected"}
            <span
              role="button"
              tabIndex={0}
              onClick={clearImportFilter}
              onKeyDown={(e) => e.key === "Enter" && clearImportFilter()}
              className="ml-1 hover:bg-muted rounded cursor-pointer"
            >
              <X className="h-3 w-3" />
            </span>
          </Badge>
        )}
      </div>

      {/* Counter and sum - always stacked vertically */}
      {showCounter && (
        <div className="flex flex-col items-end justify-center text-sm">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            {scorePercent !== undefined && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className="inline-flex">
                    <ScoreRing
                      percent={scorePercent}
                      deductiblePercent={deductiblePercent}
                    />
                  </span>
                </TooltipTrigger>
                <TooltipContent>
                  <p className="text-xs">
                    {scorePercent}% documented
                    {deductiblePercent !== undefined
                      ? `, ${deductiblePercent}% by a § 11 invoice`
                      : ""}
                  </p>
                </TooltipContent>
              </Tooltip>
            )}
            <span className={cn(
              "tabular-nums font-medium text-foreground inline-block",
              counterBumping && "animate-counter-bump"
            )}>{assignedCount ?? 0}</span>
            <span>/</span>
            <span className="tabular-nums">{totalCount}</span>
          </span>
          {/*
            The way into the chase queue (#207), beside the ring rather than in
            the filter row. Every other control in that row narrows THIS table;
            this one navigates to a different surface, so sitting among them
            read as a filter that does not filter.
            It belongs here because it is the same fact as the ring from the
            other end: the ring says how much is documented and how much of
            that is deductible, and the chase queue IS the gap between the two
            arcs, as a work list.
            Shown even at zero: before the backfill runs the queue is empty for
            everyone, and a link that only appears once there is work is a
            feature nobody ever finds.
          */}
          <Button variant="ghost" size="sm" className="h-6 gap-1.5 px-1.5 -mr-1.5" asChild>
            <Link href="/transactions/chase">
              <ReceiptText className="h-3.5 w-3.5" />
              <span className="text-xs">Chase</span>
              {chaseQueueCount > 0 && (
                <Badge variant="warning" className="h-4 px-1 text-[10px] tabular-nums">
                  {chaseQueueCount}
                </Badge>
              )}
            </Link>
          </Button>
          {filteredSum !== undefined && (
            <span
              className={cn(
                "tabular-nums",
                filteredSum < 0 ? "text-amount-negative" : "text-amount-positive"
              )}
            >
              ({formatCurrency(filteredSum)})
            </span>
          )}
        </div>
      )}
    </div>
  );
}
