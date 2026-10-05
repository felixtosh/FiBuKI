"use client";

/**
 * The Copy state of a File in its detail panel (#162, ADR-0010): "Copy of
 * File A" with Undo and "Make this the original", a Copy suggestion with
 * accept and decline, or the original's own Copies. Renders nothing for a
 * File that is none of these.
 */

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { handCorrectedFieldsOf } from "@/lib/files/hand-correction-refusal";
import { Copy, Loader2 } from "lucide-react";
import { TaxFile, CopySuggestionReason } from "@/types/file";
import { Button } from "@/components/ui/button";
import { fileDisplayName } from "@/lib/files/file-display-name";

type Done = Promise<void>;

/** A FiBuKI-generated invoice is always the original (ADR-0006). */
function isGeneratedInvoice(file: TaxFile): boolean {
  return Boolean(file.invoiceId || file.isFibukiGenerated);
}

const REASON_KEY: ReasonKeys = {
  connected: "reasonConnected",
  "no-invoice-number": "reasonNoInvoiceNumber",
  "same-content": "reasonSameContent",
  "marked-not-invoice": "reasonMarkedNotInvoice",
};

type ReasonKey = "reasonConnected" | "reasonNoInvoiceNumber" | "reasonSameContent" | "reasonMarkedNotInvoice";
type ReasonKeys = Record<CopySuggestionReason, ReasonKey>;

export type CopyAct = () => Done;
export type MarkCopyAct = (originalFileId: string) => Done;

interface FileCopySectionProps {
  file: TaxFile;
  /** The live original when this File is a Copy right now. */
  original?: TaxFile | null;
  /** The live File a Copy suggestion names, when there is one. */
  suggestedOriginal?: TaxFile | null;
  /** This File's own live Copies. */
  copies?: TaxFile[];
  onMarkAsCopy: MarkCopyAct;
  onNotACopy: CopyAct;
  onMakeOriginal: CopyAct;
}

export function FileCopySection({
  file,
  original,
  suggestedOriginal,
  copies = [],
  onMarkAsCopy,
  onNotACopy,
  onMakeOriginal,
}: FileCopySectionProps) {
  const t = useTranslations("files.copy");
  const [busy, setBusy] = useState(null as string | null);
  const [error, setError] = useState(null as string | null);

  const run = (key: string, act: () => Done) => async () => {
    setBusy(key);
    setError(null);
    try {
      await act();
    } catch (err) {
      // Marking a hidden File as a Copy un-marks it, which a Hand Correction
      // refuses; there is no override here (#639).
      setError(
        handCorrectedFieldsOf(err)
          ? t("handCorrected")
          : t("failed", { message: (err as Error)?.message ?? String(err) })
      );
    } finally {
      setBusy(null);
    }
  };

  if (original) {
    return (
      <section className="rounded-md border bg-muted/40 p-3 space-y-2" data-testid="file-copy-of">
        <div className="flex items-center gap-2 text-sm">
          <Copy className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground">{t("copyOf")}</span>
          <Link href={`/files?id=${original.id}`} className="font-medium truncate hover:underline">
            {fileDisplayName(original)}
          </Link>
        </div>
        <p className="text-xs text-muted-foreground">{t("explanation")}</p>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" disabled={busy !== null} onClick={run("undo", onNotACopy)}>
            <Spinner on={busy === "undo"} />
            {t("undo")}
          </Button>
          {isGeneratedInvoice(original) ? null : (
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={run("swap", onMakeOriginal)}>
              <Spinner on={busy === "swap"} />
              {t("makeOriginal")}
            </Button>
          )}
        </div>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </section>
    );
  }

  if (suggestedOriginal && file.copySuggestion) {
    return (
      <section className="rounded-md border border-dashed p-3 space-y-2" data-testid="file-copy-suggestion">
        <div className="flex items-center gap-2 text-sm">
          <Copy className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground">{t("suggested")}</span>
          <Link href={`/files?id=${suggestedOriginal.id}`} className="font-medium truncate hover:underline">
            {fileDisplayName(suggestedOriginal)}
          </Link>
        </div>
        <p className="text-xs text-muted-foreground">{t(REASON_KEY[file.copySuggestion.reason])}</p>
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={run("accept", () => onMarkAsCopy(suggestedOriginal.id))}
          >
            <Spinner on={busy === "accept"} />
            {t("accept")}
          </Button>
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={run("decline", onNotACopy)}>
            <Spinner on={busy === "decline"} />
            {t("decline")}
          </Button>
        </div>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
      </section>
    );
  }

  if (copies.length > 0) {
    return (
      <section className="space-y-1" data-testid="file-copies">
        <p className="text-sm font-medium">{t("copies")}</p>
        <p className="text-xs text-muted-foreground">{t("copiesExplanation")}</p>
        <ul className="space-y-0.5">
          {copies.map((c) => (
            <li key={c.id} className="flex items-center gap-2 text-sm">
              <Copy className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
              <Link href={`/files?id=${c.id}`} className="truncate hover:underline">
                {fileDisplayName(c)}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  return null;
}

/**
 * A connected original's Copies, listed under it in the Transaction detail
 * panel (#162). Shown, never counted: the original alone documents the line.
 */
export function TransactionFileCopies({ copies }: { copies: TaxFile[] }) {
  const t = useTranslations("files.copy");
  if (copies.length === 0) return null;
  return (
    <ul className="ml-4 mb-1 space-y-0.5" data-testid="transaction-file-copies">
      {copies.map((c) => (
        <li key={c.id}>
          <Link
            href={`/files?id=${c.id}`}
            className="flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
          >
            <Copy className="h-3 w-3 shrink-0" />
            <span className="shrink-0">{t("label")}:</span>
            <span className="truncate">{fileDisplayName(c)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

function Spinner({ on }: { on: boolean }) {
  if (!on) return null;
  return <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />;
}
