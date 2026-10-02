"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Check, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SearchInput } from "@/components/ui/search-input";
import { cn } from "@/lib/utils";
import type { UserPartner } from "@/types/partner";

/**
 * The Partner chip on the Files and the Transactions toolbar (#519): one
 * filter for the Partner column. The popover is a search, "No partner
 * assigned", a line, then the partners to pick. Picking partners and "No
 * partner assigned" exclude each other, so choosing one clears the other.
 */
export function PartnerFilter({
  userPartners,
  partnerIds,
  hasPartner,
  onChange,
}: {
  userPartners: UserPartner[];
  partnerIds: string[] | undefined;
  hasPartner: boolean | undefined;
  onChange: (next: { partnerIds: string[] | undefined; hasPartner: boolean | undefined }) => void;
}) {
  const t = useTranslations("filters.partner");
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");

  const selectedIds = partnerIds ?? [];
  const noPartner = selectedIds.length === 0 && hasPartner === false;
  const active = selectedIds.length > 0 || noPartner;

  const names = new Map(userPartners.map((partner) => [partner.id, partner.name]));
  const label = noPartner
    ? t("noPartnerShort")
    : selectedIds.length === 1
      ? names.get(selectedIds[0]) ?? t("label")
      : selectedIds.length > 1
        ? t("labelCount", { count: selectedIds.length })
        : t("label");

  const query = search.trim().toLowerCase();
  const visiblePartners = query
    ? userPartners.filter(
        (partner) =>
          partner.name.toLowerCase().includes(query) ||
          partner.aliases?.some((alias) => alias.toLowerCase().includes(query)) ||
          partner.vatId?.toLowerCase().includes(query) ||
          partner.website?.toLowerCase().includes(query)
      )
    : userPartners;

  const togglePartner = (partnerId: string) => {
    const next = new Set(selectedIds);
    if (next.has(partnerId)) next.delete(partnerId);
    else next.add(partnerId);
    const ids = Array.from(next);
    onChange({ partnerIds: ids.length > 0 ? ids : undefined, hasPartner: undefined });
  };

  const toggleNoPartner = () =>
    onChange({ partnerIds: undefined, hasPartner: noPartner ? undefined : false });

  const clear = (e: React.SyntheticEvent) => {
    e.stopPropagation();
    onChange({ partnerIds: undefined, hasPartner: undefined });
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant={active ? "secondary" : "outline"} size="sm" className="h-9 gap-2">
          <span>{label}</span>
          {active && (
            <span
              role="button"
              tabIndex={0}
              aria-label={t("clear")}
              onClick={clear}
              onKeyDown={(e) => e.key === "Enter" && clear(e)}
              className="ml-1 hover:bg-muted rounded p-0.5 -mr-1 cursor-pointer"
            >
              <X className="h-3 w-3" />
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-3" align="start">
        <div className="space-y-2">
          <SearchInput placeholder={t("search")} value={search} onChange={setSearch} />
          <CheckRow checked={noPartner} onClick={toggleNoPartner} label={t("noPartner")} />
          <div className="border-t" />
          <div className="max-h-56 overflow-y-auto space-y-1">
            {visiblePartners.length === 0 ? (
              <p className="text-xs text-muted-foreground py-2 text-center">{t("none")}</p>
            ) : (
              visiblePartners.map((partner) => (
                <CheckRow
                  key={partner.id}
                  checked={selectedIds.includes(partner.id)}
                  onClick={() => togglePartner(partner.id)}
                  label={partner.name}
                />
              ))
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function CheckRow({ checked, onClick, label }: { checked: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onClick}
      className={cn(
        "w-full text-left flex items-center gap-2 rounded px-2 py-1.5 text-sm",
        checked ? "bg-muted" : "hover:bg-muted/50"
      )}
    >
      <span
        className={cn(
          "h-4 w-4 rounded border flex items-center justify-center shrink-0",
          checked ? "border-primary text-primary" : "border-muted-foreground/40 text-transparent"
        )}
      >
        <Check className="h-3 w-3" />
      </span>
      <span className="truncate">{label}</span>
    </button>
  );
}
