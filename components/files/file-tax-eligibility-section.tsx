"use client";

/**
 * The findings that change what a File is worth for tax, in a section of
 * their own below Partner and Transaction: one line each, the why behind the
 * info icon, an action where the User can settle it. They used to be bordered
 * boxes above the extracted figures and took most of the panel.
 *
 * A FINDING per the panel's rule (file-detail-panel.tsx): something a person
 * must look at. An explanation does not belong here.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { AlertTriangle, Loader2 } from "lucide-react";
import type { TaxFile } from "@/types/file";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { InfoPopover } from "@/components/ui/info-popover";
import { callFunction } from "@/lib/firebase/callable";
import {
  describeDirectionReview,
  describeForeignRecipient,
  describeRepairAmbiguity,
  describeRksvCodeReview,
} from "@/lib/documents/document-type-presentation";
import { useDocumentLabel } from "@/hooks/use-document-label";

export function FileTaxEligibilitySection({ file }: { file: TaxFile }) {
  const t = useTranslations("files.taxEligibility");
  const tx = useTranslations("files.extracted");
  const documentLabel = useDocumentLabel();
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(null as string | null);

  const foreignRecipient = describeForeignRecipient(file.foreignRecipient);
  const repairAmbiguity = describeRepairAmbiguity(file);
  const rksvCodeReview = describeRksvCodeReview(file);
  const directionReview = describeDirectionReview(file);
  const directionConflict = directionReview && directionReview.reason === "conflict" ? directionReview : null;

  if (!foreignRecipient && !repairAmbiguity && !rksvCodeReview && !directionConflict) return null;

  const confirmRecipient = async () => {
    setConfirming(true);
    setError(null);
    try {
      await callFunction("confirmFileRecipientIsUser", { fileId: file.id });
    } catch (err) {
      setError(t("failed", { message: (err as Error)?.message ?? String(err) }));
    } finally {
      setConfirming(false);
    }
  };

  return (
    <>
      <Separator />
      <div className="space-y-2">
        <h3 className="text-sm font-semibold">{t("title")}</h3>

        {foreignRecipient ? (
          <div className="space-y-1.5">
            <Finding title={t("foreignRecipient.title")} info={t("foreignRecipient.text")} infoLabel={t("why")} />
            <div className="flex items-center justify-between gap-2 pl-6">
              <p className="text-xs text-muted-foreground">{t("foreignRecipient.question")}</p>
              <Button size="sm" variant="outline" className="h-7 shrink-0" onClick={confirmRecipient} disabled={confirming}>
                {confirming ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
                {t("foreignRecipient.confirm")}
              </Button>
            </div>
          </div>
        ) : null}

        {rksvCodeReview ? (
          <Finding
            title={tx("rksvCodeReview.label")}
            info={tx("rksvCodeReview.text", { rates: formatRates(rksvCodeReview.rates) })}
            infoLabel={t("why")}
          />
        ) : null}

        {directionConflict ? (
          <Finding
            title={documentLabel(directionConflict)}
            info={`${directionConflict.text}${directionConflict.suggestion ? ` ${directionConflict.suggestion}` : ""}`}
            infoLabel={t("why")}
          />
        ) : null}

        {repairAmbiguity ? (
          <Finding title={repairAmbiguity.label} info={repairAmbiguity.text} infoLabel={t("why")} />
        ) : null}

        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </div>
    </>
  );
}

/** One finding: a warning and its title; the explanation behind the info icon. */
function Finding({ title, info, infoLabel }: { title: string; info: string; infoLabel: string }) {
  return (
    <div className="flex items-center gap-2 text-sm">
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-500" />
      <span className="flex-1 min-w-0">{title}</span>
      <InfoPopover label={infoLabel}>
        <p className="text-xs text-muted-foreground">{info}</p>
      </InfoPopover>
    </div>
  );
}

/** "10%, 13%": the rates a review names, in the order it stored them. */
function formatRates(rates: number[]): string {
  return rates.map((rate) => `${rate}%`).join(", ");
}
