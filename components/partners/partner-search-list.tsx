"use client";

import { useState, useMemo } from "react";
import { Globe, Building2, Sparkles } from "lucide-react";
import { SearchInput } from "@/components/ui/search-input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { UserPartner, GlobalPartner, PartnerSuggestion } from "@/types/partner";
import { cn } from "@/lib/utils";

interface PartnerSuggestionWithDetails extends PartnerSuggestion {
  partner: UserPartner | GlobalPartner;
}

interface PartnerSearchListProps {
  userPartners: UserPartner[];
  globalPartners: GlobalPartner[];
  onSelect: (partnerId: string, partnerType: "user" | "global") => void;
  suggestions?: PartnerSuggestionWithDetails[];
  onSelectSuggestion?: (suggestion: PartnerSuggestionWithDetails) => void;
}

type CombinedPartner = (UserPartner | GlobalPartner) & {
  type: "user" | "global";
};

export function PartnerSearchList({
  userPartners,
  globalPartners,
  onSelect,
  suggestions = [],
  onSelectSuggestion,
}: PartnerSearchListProps) {
  const [search, setSearch] = useState("");

  // Combine and filter partners
  // Filter out global partners that have a local copy (linked via globalPartnerId)
  const filteredPartners = useMemo(() => {
    // Build set of globalPartnerIds that have local copies
    const localizedGlobalIds = new Set(
      userPartners
        .filter((p) => p.globalPartnerId)
        .map((p) => p.globalPartnerId!)
    );

    // Filter globals - exclude those with local copies
    const filteredGlobals = globalPartners.filter(
      (g) => !localizedGlobalIds.has(g.id)
    );

    const combined: CombinedPartner[] = [
      // User partners first (they take priority)
      ...userPartners.map((p) => ({ ...p, type: "user" as const })),
      // Then globals without local copies
      ...filteredGlobals.map((p) => ({ ...p, type: "global" as const })),
    ];

    if (!search.trim()) {
      return combined.slice(0, 50); // Limit initial display
    }

    const searchLower = search.toLowerCase();
    return combined.filter(
      (p) =>
        p.name.toLowerCase().includes(searchLower) ||
        p.vatId?.toLowerCase().includes(searchLower) ||
        p.website?.toLowerCase().includes(searchLower) ||
        p.aliases?.some((a) => a.toLowerCase().includes(searchLower))
    );
  }, [userPartners, globalPartners, search]);

  const hasSuggestions = suggestions.length > 0 && !search.trim();

  return (
    <div className="flex flex-col h-full">
      <div className="mb-3">
        <SearchInput
          placeholder="Search partners..."
          value={search}
          onChange={setSearch}
        />
      </div>

      <ScrollArea className="flex-1 -mx-1 px-1">
        <div className="space-y-1">
          {/* Suggestions section - shown at top when not searching */}
          {hasSuggestions && (
            <>
              <div className="flex items-center gap-1.5 px-2 py-1">
                <Sparkles className="h-3 w-3 text-info-foreground" />
                <span className="text-xs font-medium text-muted-foreground">Suggestions</span>
              </div>
              {suggestions.map((suggestion) => (
                <button
                  key={`suggestion-${suggestion.partnerId}`}
                  type="button"
                  onClick={() => onSelectSuggestion?.(suggestion)}
                  className="w-full text-left p-2 rounded-md transition-colors bg-info hover:bg-info/80 border border-info-border"
                >
                  <div className="flex items-start gap-2">
                    {suggestion.partnerType === "global" ? (
                      <Globe className="h-4 w-4 text-blue-500 mt-0.5 flex-shrink-0" />
                    ) : (
                      <Building2 className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <p className="text-sm font-medium truncate text-info-foreground">{suggestion.partner.name}</p>
                        <span
                          className={cn(
                            "text-xs px-1.5 py-0.5 rounded flex-shrink-0",
                            suggestion.confidence >= 90
                              ? "bg-green-50 text-green-900 dark:bg-green-900/30 dark:text-green-300"
                              : suggestion.confidence >= 75
                              ? "bg-amber-50 text-amber-900 dark:bg-amber-900/30 dark:text-amber-300"
                              : "bg-muted text-muted-foreground"
                          )}
                        >
                          {suggestion.confidence}%
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground">
                        Matched by {suggestion.source}
                      </p>
                    </div>
                  </div>
                </button>
              ))}
              <div className="border-t my-2" />
              <p className="text-xs text-muted-foreground px-2 pb-1">All Partners</p>
            </>
          )}

          {/* Regular partners list */}
          {filteredPartners.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              No partners found
            </p>
          ) : (
            filteredPartners.map((partner) => (
              <button
                key={`${partner.type}-${partner.id}`}
                type="button"
                onClick={() => onSelect(partner.id, partner.type)}
                className={cn(
                  "w-full text-left p-2 rounded-md transition-colors",
                  "hover:bg-muted/50 focus:bg-muted/50 focus:outline-none"
                )}
              >
                <div className="flex items-start gap-2">
                  {partner.type === "global" ? (
                    <Globe className="h-4 w-4 text-blue-500 mt-0.5 flex-shrink-0" />
                  ) : (
                    <Building2 className="h-4 w-4 text-muted-foreground mt-0.5 flex-shrink-0" />
                  )}
                  <div className="min-w-0 flex-1 overflow-hidden">
                    <p className="text-sm font-medium truncate">{partner.name}</p>
                    <div className="text-xs text-muted-foreground overflow-hidden">
                      {partner.vatId && (
                        <p className="truncate">VAT: {partner.vatId}</p>
                      )}
                      {partner.ibans && partner.ibans.length > 0 && (
                        <p className="truncate">IBAN: {partner.ibans[0]}</p>
                      )}
                      {partner.website && (
                        <p className="truncate">{partner.website}</p>
                      )}
                    </div>
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </ScrollArea>

      <p className="text-xs text-muted-foreground mt-2 text-center">
        {filteredPartners.length} of {userPartners.length + globalPartners.length} partners
      </p>
    </div>
  );
}
