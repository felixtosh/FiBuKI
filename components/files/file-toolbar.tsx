"use client";

import { useState } from "react";
import { format } from "date-fns";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import {
  CalendarDays,
  Link2,
  ArrowUpDown,
  X,
  CalendarIcon,
  Check,
  Filter,
  Trash2,
  FileX,
  EyeOff,
} from "lucide-react";
import { SearchButton } from "@/components/ui/search-button";
import { SearchInput } from "@/components/ui/search-input";
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
  const [connectionPopoverOpen, setConnectionPopoverOpen] = useState(false);
  const [typePopoverOpen, setTypePopoverOpen] = useState(false);
  const [partnerPopoverOpen, setPartnerPopoverOpen] = useState(false);
  const [statusPopoverOpen, setStatusPopoverOpen] = useState(false);
  const [partnerSearch, setPartnerSearch] = useState("");
  const [showFromCalendar, setShowFromCalendar] = useState(false);
  const [showToCalendar, setShowToCalendar] = useState(false);

  const hasDateFilter = filters.extractedDateFrom || filters.extractedDateTo;
  const hasConnectionFilter = filters.hasConnections !== undefined;
  const hasAmountFilter = filters.amountType && filters.amountType !== "all";
  const selectedPartnerIds = filters.partnerIds || [];
  const hasPartnerFilter = selectedPartnerIds.length > 0;
  const hasStatusFilter =
    filters.extractionComplete !== undefined ||
    filters.isNotInvoice !== undefined ||
    filters.includeDeleted === true;

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

  const clearConnectionFilter = (e: React.MouseEvent) => {
    e.stopPropagation();
    onFiltersChange({ ...filters, hasConnections: undefined });
  };

  const clearAmountFilter = (e: React.MouseEvent) => {
    e.stopPropagation();
    onFiltersChange({ ...filters, amountType: undefined });
  };

  const clearPartnerFilter = (e: React.MouseEvent) => {
    e.stopPropagation();
    onFiltersChange({ ...filters, partnerIds: undefined });
  };

  const clearStatusFilter = (e: React.MouseEvent) => {
    e.stopPropagation();
    onFiltersChange({
      ...filters,
      extractionComplete: undefined,
      isNotInvoice: undefined,
      includeDeleted: undefined,
    });
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

  const getConnectionLabel = () => {
    if (filters.hasConnections === true) return "Connected";
    if (filters.hasConnections === false) return "Unconnected";
    return "Transactions";
  };

  const getAmountLabel = () => {
    if (filters.amountType === "income") return "Income";
    if (filters.amountType === "expense") return "Expenses";
    return "Type";
  };

  const getStatusLabel = () => {
    if (filters.extractionComplete === true) return "Extracted";
    if (filters.extractionComplete === false) return "Pending";
    if (filters.isNotInvoice === true) return "Not invoices";
    if (filters.isNotInvoice === false) return "Hide not invoices";
    if (filters.includeDeleted === true) return "Deleted";
    return "Status";
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

  // Show counter only when there are files
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

      {/* Connection filter */}
      <Popover open={connectionPopoverOpen} onOpenChange={setConnectionPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            variant={hasConnectionFilter ? "secondary" : "outline"}
            size="sm"
            className="h-9 gap-2"
          >
            <Link2 className="h-4 w-4" />
            <span>{getConnectionLabel()}</span>
            {hasConnectionFilter && (
              <span
                role="button"
                tabIndex={0}
                onClick={clearConnectionFilter}
                onKeyDown={(e) => e.key === "Enter" && clearConnectionFilter(e as unknown as React.MouseEvent)}
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
              variant={filters.hasConnections === undefined ? "secondary" : "ghost"}
              size="sm"
              className="justify-start h-8"
              onClick={() => {
                onFiltersChange({ ...filters, hasConnections: undefined });
                setConnectionPopoverOpen(false);
              }}
            >
              All
            </Button>
            <Button
              variant={filters.hasConnections === true ? "secondary" : "ghost"}
              size="sm"
              className="justify-start h-8"
              onClick={() => {
                onFiltersChange({ ...filters, hasConnections: true });
                setConnectionPopoverOpen(false);
              }}
            >
              Connected
            </Button>
            <Button
              variant={filters.hasConnections === false ? "secondary" : "ghost"}
              size="sm"
              className="justify-start h-8"
              onClick={() => {
                onFiltersChange({ ...filters, hasConnections: false });
                setConnectionPopoverOpen(false);
              }}
            >
              Unconnected
            </Button>
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

      {/* Status filter */}
      <Popover open={statusPopoverOpen} onOpenChange={setStatusPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            variant={hasStatusFilter ? "secondary" : "outline"}
            size="sm"
            className="h-9 gap-2"
          >
            <Filter className="h-4 w-4" />
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
              variant={
                filters.extractionComplete === undefined &&
                filters.isNotInvoice === undefined &&
                !filters.includeDeleted
                  ? "secondary"
                  : "ghost"
              }
              size="sm"
              className="justify-start h-8"
              onClick={() => {
                onFiltersChange({
                  ...filters,
                  extractionComplete: undefined,
                  isNotInvoice: undefined,
                  includeDeleted: undefined,
                });
                setStatusPopoverOpen(false);
              }}
            >
              All
            </Button>
            <Button
              variant={filters.extractionComplete === true ? "secondary" : "ghost"}
              size="sm"
              className="justify-start h-8"
              onClick={() => {
                onFiltersChange({
                  ...filters,
                  extractionComplete: true,
                  isNotInvoice: undefined,
                  includeDeleted: undefined,
                });
                setStatusPopoverOpen(false);
              }}
            >
              Extraction complete
            </Button>
            <Button
              variant={filters.extractionComplete === false ? "secondary" : "ghost"}
              size="sm"
              className="justify-start h-8"
              onClick={() => {
                onFiltersChange({
                  ...filters,
                  extractionComplete: false,
                  isNotInvoice: undefined,
                  includeDeleted: undefined,
                });
                setStatusPopoverOpen(false);
              }}
            >
              Pending extraction
            </Button>
            <div className="border-t my-1" />
            <Button
              variant={filters.isNotInvoice === true ? "secondary" : "ghost"}
              size="sm"
              className="justify-start h-8 gap-2"
              onClick={() => {
                onFiltersChange({
                  ...filters,
                  extractionComplete: undefined,
                  isNotInvoice: true,
                  includeDeleted: undefined,
                });
                setStatusPopoverOpen(false);
              }}
            >
              <FileX className="h-4 w-4" />
              Not invoices
            </Button>
            <Button
              variant={filters.isNotInvoice === false ? "secondary" : "ghost"}
              size="sm"
              className="justify-start h-8 gap-2"
              onClick={() => {
                onFiltersChange({
                  ...filters,
                  extractionComplete: undefined,
                  isNotInvoice: false,
                  includeDeleted: undefined,
                });
                setStatusPopoverOpen(false);
              }}
            >
              <EyeOff className="h-4 w-4" />
              Hide not invoices
            </Button>
            <div className="border-t my-1" />
            <Button
              variant={filters.includeDeleted === true ? "secondary" : "ghost"}
              size="sm"
              className="justify-start h-8 gap-2 text-muted-foreground"
              onClick={() => {
                onFiltersChange({
                  ...filters,
                  extractionComplete: undefined,
                  isNotInvoice: undefined,
                  includeDeleted: true,
                });
                setStatusPopoverOpen(false);
              }}
            >
              <Trash2 className="h-4 w-4" />
              Include deleted
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      </div>

      {/* Right side: counter */}
      {showCounter && (
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground shrink-0">
          <span className="tabular-nums font-medium text-foreground">{connectedCount ?? 0}</span>
          <span>/</span>
          <span className="tabular-nums">{totalCount}</span>
        </div>
      )}
    </div>
  );
}
