"use client";

import { useTranslations } from "next-intl";
import { GitMerge } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { FieldRow, PanelHeader } from "@/components/ui/detail-panel-primitives";
import { isRecurringPartner } from "@/lib/partners/billing-cycle-presentation";
import type { UserPartner } from "@/types/partner";

/**
 * The detail sidebar while several Partners are selected (#524), the same
 * pattern as the Files bulk panel: a summary of the selection on top (the
 * rows themselves are highlighted in the list), the bulk action in the footer
 * where a single Partner's actions sit.
 */
export function PartnerBulkPanel({
  partners,
  onMerge,
  onClearSelection,
}: {
  partners: UserPartner[];
  onMerge: () => void;
  onClearSelection: () => void;
}) {
  const t = useTranslations("partners.bulk");
  const count = partners.length;
  const { withVatId, withIban, recurring } = summarize(partners);

  return (
    <div className="h-full flex flex-col">
      <PanelHeader title={t("title", { count })} onClose={onClearSelection} />

      <ScrollArea className="flex-1">
        <div className="p-4">
          <FieldRow label={t("withVatId")}>
            <span className="block text-right">{t("ofCount", { part: withVatId, count })}</span>
          </FieldRow>
          <FieldRow label={t("withIban")}>
            <span className="block text-right">{t("ofCount", { part: withIban, count })}</span>
          </FieldRow>
          <FieldRow label={t("recurring")}>
            <span className="block text-right">{t("ofCount", { part: recurring, count })}</span>
          </FieldRow>
        </div>
      </ScrollArea>

      <div className="p-4 border-t flex flex-col gap-2">
        {count < 2 && <p className="text-xs text-muted-foreground">{t("mergeNeedsTwo")}</p>}
        <Button variant="outline" onClick={onMerge} disabled={count < 2}>
          <GitMerge className="h-4 w-4 mr-2" />
          {t("merge", { count })}
        </Button>
      </div>
    </div>
  );
}

function summarize(partners: UserPartner[]) {
  let withVatId = 0;
  let withIban = 0;
  let recurring = 0;
  for (const partner of partners) {
    if (partner.vatId) withVatId++;
    if (partner.ibans.length) withIban++;
    if (isRecurringPartner(partner)) recurring++;
  }
  return { withVatId, withIban, recurring };
}
