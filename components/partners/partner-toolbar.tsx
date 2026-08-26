"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Plus,
  X,
  FileText,
  CreditCard,
  Globe,
  Repeat,
} from "lucide-react";
import { SearchButton } from "@/components/ui/search-button";
import { PartnerFilters } from "@/types/partner";

interface PartnerToolbarProps {
  searchValue: string;
  onSearchChange: (value: string) => void;
  filters: PartnerFilters;
  onFiltersChange: (filters: PartnerFilters) => void;
  onAddPartner: () => void;
}

export function PartnerToolbar({
  searchValue,
  onSearchChange,
  filters,
  onFiltersChange,
  onAddPartner,
}: PartnerToolbarProps) {
  const [vatPopoverOpen, setVatPopoverOpen] = useState(false);
  const [ibanPopoverOpen, setIbanPopoverOpen] = useState(false);
  const [countryPopoverOpen, setCountryPopoverOpen] = useState(false);
  const [recurringPopoverOpen, setRecurringPopoverOpen] = useState(false);
  const t = useTranslations("billingCycle");

  const hasVatFilter = filters.hasVatId !== undefined;
  const hasIbanFilter = filters.hasIban !== undefined;
  const hasCountryFilter = !!filters.country;
  const hasRecurringFilter = filters.isRecurring !== undefined;

  const clearVatFilter = (e: React.MouseEvent) => {
    e.stopPropagation();
    onFiltersChange({ ...filters, hasVatId: undefined });
  };

  const clearIbanFilter = (e: React.MouseEvent) => {
    e.stopPropagation();
    onFiltersChange({ ...filters, hasIban: undefined });
  };

  const clearCountryFilter = (e: React.MouseEvent) => {
    e.stopPropagation();
    onFiltersChange({ ...filters, country: undefined });
  };

  const clearRecurringFilter = (e: React.MouseEvent) => {
    e.stopPropagation();
    onFiltersChange({ ...filters, isRecurring: undefined });
  };

  const getRecurringLabel = () => {
    if (filters.isRecurring === true) return t("filter.recurring");
    if (filters.isRecurring === false) return t("filter.notRecurring");
    return t("filter.label");
  };

  const getVatLabel = () => {
    if (filters.hasVatId === true) return "Has VAT ID";
    if (filters.hasVatId === false) return "No VAT ID";
    return "VAT ID";
  };

  const getIbanLabel = () => {
    if (filters.hasIban === true) return "Has IBAN";
    if (filters.hasIban === false) return "No IBAN";
    return "IBAN";
  };

  const getCountryLabel = () => {
    if (filters.country) return filters.country.toUpperCase();
    return "Country";
  };

  // Common countries for quick selection
  const commonCountries = [
    { code: "AT", name: "Austria" },
    { code: "DE", name: "Germany" },
    { code: "CH", name: "Switzerland" },
    { code: "US", name: "United States" },
    { code: "GB", name: "United Kingdom" },
  ];

  return (
    <div className="flex items-center gap-2 px-4 py-2 border-b bg-background flex-wrap">
      {/* Search button */}
      <SearchButton
        value={searchValue}
        onSearch={onSearchChange}
        placeholder="Search partners..."
      />

      {/* VAT ID filter */}
      <Popover open={vatPopoverOpen} onOpenChange={setVatPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            variant={hasVatFilter ? "secondary" : "outline"}
            size="sm"
            className="h-9 gap-2"
          >
            <FileText className="h-4 w-4" />
            <span>{getVatLabel()}</span>
            {hasVatFilter && (
              <span
                role="button"
                tabIndex={0}
                onClick={clearVatFilter}
                onKeyDown={(e) => e.key === "Enter" && clearVatFilter(e as unknown as React.MouseEvent)}
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
              variant={filters.hasVatId === undefined ? "secondary" : "ghost"}
              size="sm"
              className="justify-start h-8"
              onClick={() => {
                onFiltersChange({ ...filters, hasVatId: undefined });
                setVatPopoverOpen(false);
              }}
            >
              All
            </Button>
            <Button
              variant={filters.hasVatId === true ? "secondary" : "ghost"}
              size="sm"
              className="justify-start h-8"
              onClick={() => {
                onFiltersChange({ ...filters, hasVatId: true });
                setVatPopoverOpen(false);
              }}
            >
              Has VAT ID
            </Button>
            <Button
              variant={filters.hasVatId === false ? "secondary" : "ghost"}
              size="sm"
              className="justify-start h-8"
              onClick={() => {
                onFiltersChange({ ...filters, hasVatId: false });
                setVatPopoverOpen(false);
              }}
            >
              No VAT ID
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      {/* IBAN filter */}
      <Popover open={ibanPopoverOpen} onOpenChange={setIbanPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            variant={hasIbanFilter ? "secondary" : "outline"}
            size="sm"
            className="h-9 gap-2"
          >
            <CreditCard className="h-4 w-4" />
            <span>{getIbanLabel()}</span>
            {hasIbanFilter && (
              <span
                role="button"
                tabIndex={0}
                onClick={clearIbanFilter}
                onKeyDown={(e) => e.key === "Enter" && clearIbanFilter(e as unknown as React.MouseEvent)}
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
              variant={filters.hasIban === undefined ? "secondary" : "ghost"}
              size="sm"
              className="justify-start h-8"
              onClick={() => {
                onFiltersChange({ ...filters, hasIban: undefined });
                setIbanPopoverOpen(false);
              }}
            >
              All
            </Button>
            <Button
              variant={filters.hasIban === true ? "secondary" : "ghost"}
              size="sm"
              className="justify-start h-8"
              onClick={() => {
                onFiltersChange({ ...filters, hasIban: true });
                setIbanPopoverOpen(false);
              }}
            >
              Has IBAN
            </Button>
            <Button
              variant={filters.hasIban === false ? "secondary" : "ghost"}
              size="sm"
              className="justify-start h-8"
              onClick={() => {
                onFiltersChange({ ...filters, hasIban: false });
                setIbanPopoverOpen(false);
              }}
            >
              No IBAN
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      {/* Country filter */}
      <Popover open={countryPopoverOpen} onOpenChange={setCountryPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            variant={hasCountryFilter ? "secondary" : "outline"}
            size="sm"
            className="h-9 gap-2"
          >
            <Globe className="h-4 w-4" />
            <span>{getCountryLabel()}</span>
            {hasCountryFilter && (
              <span
                role="button"
                tabIndex={0}
                onClick={clearCountryFilter}
                onKeyDown={(e) => e.key === "Enter" && clearCountryFilter(e as unknown as React.MouseEvent)}
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
              variant={!filters.country ? "secondary" : "ghost"}
              size="sm"
              className="justify-start h-8"
              onClick={() => {
                onFiltersChange({ ...filters, country: undefined });
                setCountryPopoverOpen(false);
              }}
            >
              All countries
            </Button>
            <div className="border-t my-1" />
            {commonCountries.map((c) => (
              <Button
                key={c.code}
                variant={filters.country === c.code ? "secondary" : "ghost"}
                size="sm"
                className="justify-start h-8"
                onClick={() => {
                  onFiltersChange({ ...filters, country: c.code });
                  setCountryPopoverOpen(false);
                }}
              >
                {c.name}
              </Button>
            ))}
          </div>
        </PopoverContent>
      </Popover>

      {/* Recurring filter */}
      <Popover open={recurringPopoverOpen} onOpenChange={setRecurringPopoverOpen}>
        <PopoverTrigger asChild>
          <Button
            variant={hasRecurringFilter ? "secondary" : "outline"}
            size="sm"
            className="h-9 gap-2"
          >
            <Repeat className="h-4 w-4" />
            <span>{getRecurringLabel()}</span>
            {hasRecurringFilter && (
              <span
                role="button"
                tabIndex={0}
                onClick={clearRecurringFilter}
                onKeyDown={(e) => e.key === "Enter" && clearRecurringFilter(e as unknown as React.MouseEvent)}
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
              variant={filters.isRecurring === undefined ? "secondary" : "ghost"}
              size="sm"
              className="justify-start h-8"
              onClick={() => {
                onFiltersChange({ ...filters, isRecurring: undefined });
                setRecurringPopoverOpen(false);
              }}
            >
              {t("filter.all")}
            </Button>
            <Button
              variant={filters.isRecurring === true ? "secondary" : "ghost"}
              size="sm"
              className="justify-start h-8"
              onClick={() => {
                onFiltersChange({ ...filters, isRecurring: true });
                setRecurringPopoverOpen(false);
              }}
            >
              {t("filter.recurring")}
            </Button>
            <Button
              variant={filters.isRecurring === false ? "secondary" : "ghost"}
              size="sm"
              className="justify-start h-8"
              onClick={() => {
                onFiltersChange({ ...filters, isRecurring: false });
                setRecurringPopoverOpen(false);
              }}
            >
              {t("filter.notRecurring")}
            </Button>
          </div>
        </PopoverContent>
      </Popover>

      <div className="flex-1" />

      <Button onClick={onAddPartner} size="sm">
        <Plus className="h-4 w-4 mr-2" />
        Add Partner
      </Button>
    </div>
  );
}
