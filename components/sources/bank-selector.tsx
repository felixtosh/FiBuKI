"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Building2, Search, Loader2, ArrowLeft } from "lucide-react";
import { useInstitutions, filterInstitutions, Institution, BankingProvider } from "@/hooks/use-institutions";
import { FINAPI_COUNTRY_OPTIONS } from "@/lib/banking/finapi-countries";

/** Countries with active PSD2 banking connections (none yet — all in funding) */
const LIVE_COUNTRIES = new Set<string>([]);

const COUNTRIES = FINAPI_COUNTRY_OPTIONS;

interface BankSelectorProps {
  selectedCountry: string | null;
  onCountrySelect: (country: string) => void;
  onBankSelect: (institution: Institution) => void;
  onBack?: () => void;
  isLoading?: boolean;
  /** Which provider to use. Defaults to "all" */
  provider?: BankingProvider;
}

export function BankSelector({
  selectedCountry,
  onCountrySelect,
  onBankSelect,
  onBack,
  isLoading = false,
  provider = "all",
}: BankSelectorProps) {
  const router = useRouter();
  const [countrySearchQuery, setCountrySearchQuery] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const { institutions, loading, error } = useInstitutions({
    countryCode: selectedCountry,
    provider,
  });

  const filteredCountries = useMemo(() => {
    const query = countrySearchQuery.trim().toLowerCase();
    if (!query) return COUNTRIES;
    return COUNTRIES.filter((country) =>
      `${country.name} ${country.code} ${country.description || ""}`.toLowerCase().includes(query)
    );
  }, [countrySearchQuery]);

  const filteredInstitutions = useMemo(
    () => filterInstitutions(institutions, searchQuery),
    [institutions, searchQuery]
  );

  // Country selection view
  if (!selectedCountry) {
    return (
      <div className="space-y-4">
        <div className="text-center mb-6">
          <h3 className="text-lg font-semibold">Select Your Country</h3>
          <p className="text-sm text-muted-foreground">
            Choose the country where your bank is located
          </p>
        </div>

        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search countries..."
            value={countrySearchQuery}
            onChange={(e) => setCountrySearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>

        <ScrollArea className="h-[260px] rounded-md border">
          <div className="p-2 space-y-1">
            {filteredCountries.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No countries found matching your search
              </div>
            ) : (
              filteredCountries.map((country) => {
                const isLive = LIVE_COUNTRIES.has(country.code);
                return (
                  <button
                    key={country.code}
                    type="button"
                    onClick={() => {
                      if (isLive) {
                        onCountrySelect(country.code);
                      } else {
                        router.push(`/expand/${country.code.toLowerCase()}`);
                      }
                    }}
                    className="w-full text-left px-3 py-2 rounded-md hover:bg-muted/50 transition-colors flex items-center justify-between"
                  >
                    <span>
                      <span className="font-medium">{country.name}</span>
                      <span className="text-xs text-muted-foreground ml-2">({country.code})</span>
                      {country.description && (
                        <span className="text-xs text-muted-foreground ml-2">
                          {country.description}
                        </span>
                      )}
                    </span>
                    {!isLive && (
                      <span className="text-xs text-muted-foreground shrink-0 ml-2">
                        Help unlock &rarr;
                      </span>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </ScrollArea>
      </div>
    );
  }

  // Bank selection view
  const countryName = COUNTRIES.find((c) => c.code === selectedCountry)?.name || selectedCountry;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 mb-4">
        {onBack && (
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Button>
        )}
        <div className="flex-1">
          <h3 className="text-lg font-semibold">Select Your Bank</h3>
          <p className="text-sm text-muted-foreground">
            Banks available in {countryName}
          </p>
        </div>
      </div>

      {/* Search input */}
      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Search banks..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-9"
        />
      </div>

      {/* Error state */}
      {error && (
        <div className="text-center py-8 text-destructive">
          <p>{error}</p>
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          <span className="ml-2 text-muted-foreground">Loading banks...</span>
        </div>
      )}

      {/* Bank list */}
      {!loading && !error && (
        <ScrollArea className="h-[400px]">
          <div className="space-y-2 pr-4">
            {filteredInstitutions.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                {searchQuery
                  ? "No banks found matching your search"
                  : "No banks available for this country"}
              </div>
            ) : (
              filteredInstitutions.map((institution) => (
                <BankCard
                  key={institution.id}
                  institution={institution}
                  onClick={() => onBankSelect(institution)}
                  disabled={isLoading}
                />
              ))
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

interface BankCardProps {
  institution: Institution;
  onClick: () => void;
  disabled?: boolean;
}

function BankCard({ institution, onClick, disabled }: BankCardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="w-full flex items-center gap-3 p-3 rounded-lg border hover:bg-muted/50 transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-left"
    >
      {institution.logo ? (
        <img
          src={institution.logo}
          alt={institution.name}
          className="w-10 h-10 rounded object-contain bg-white"
        />
      ) : (
        <div className="w-10 h-10 rounded bg-primary/10 flex items-center justify-center">
          <Building2 className="h-5 w-5 text-primary" />
        </div>
      )}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <p className="font-medium truncate">{institution.name}</p>
          {institution.providerId && (
            <ProviderBadge providerId={institution.providerId} />
          )}
        </div>
        <p className="text-xs text-muted-foreground">
          Up to {institution.transaction_total_days} days of history
        </p>
      </div>
    </button>
  );
}

function ProviderBadge({ providerId }: { providerId: string }) {
  const providerInfo: Record<string, { name: string; color: string; fullName: string }> = {
    finapi: { name: "fA", color: "bg-orange-50 text-orange-900 border border-orange-300", fullName: "finAPI" },
    truelayer: { name: "TL", color: "bg-blue-50 text-blue-900 border border-blue-300", fullName: "TrueLayer" },
    plaid: { name: "PL", color: "bg-purple-50 text-purple-900 border border-purple-300", fullName: "Plaid" },
  };

  const info = providerInfo[providerId];
  if (!info) return null;

  return (
    <span
      className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${info.color}`}
      title={`via ${info.fullName}`}
    >
      {info.name}
    </span>
  );
}
