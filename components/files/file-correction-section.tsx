"use client";

/**
 * The Invoice Correction state of a File in its detail panel (#564,
 * ADR-0010): the File it corrects and the Transaction that paid it, with Unlink, the link
 * suggestions, a manual link to another File of the same Partner, and, on an
 * original, the corrections linked to it. Renders nothing for a File that is
 * neither a correction nor corrected.
 *
 * The view comes from the getCorrection callable, the same one the MCP and
 * chat tools read, so every surface shows the same link.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { FileMinus, Loader2, TriangleAlert } from "lucide-react";
import { TaxFile } from "@/types/file";
import { Button } from "@/components/ui/button";
import { callFunction } from "@/lib/firebase/callable";
import { formatCurrency } from "@/lib/utils";
import type { CorrectionFileView } from "@/types/correction";

/** A link act; written as a call signature so the string lint (#168) does not read the generic as copy. */
type Act = { (): Promise<unknown> };

/** Worth asking the server about: a correction, or a File that could be an original. */
function mayHaveCorrection(file: TaxFile): boolean {
  return (
    file.correctionKind === "invoice-correction" ||
    !!file.correctionLink ||
    (file.correctionSuggestions?.length ?? 0) > 0 ||
    !!file.invoiceId ||
    (file.transactionIds?.length ?? 0) > 0
  );
}

export function FileCorrectionSection({ file }: { file: TaxFile }) {
  const t = useTranslations("files.correction");
  const [view, setView] = useState(null as CorrectionFileView | null);
  const [busy, setBusy] = useState(null as string | null);
  const [error, setError] = useState(null as string | null);
  const [chosen, setChosen] = useState("");

  const relevant = mayHaveCorrection(file);
  // Re-read whenever the stored link or suggestions change under the panel.
  const linkKey = `${file.id}|${file.correctionLink?.fileId ?? ""}|${file.correctionSuggestions?.length ?? 0}|${file.correctionKind ?? ""}`;

  const load = useCallback(async () => {
    if (!relevant) {
      setView(null);
      return;
    }
    try {
      setView(await callFunction<{ fileId: string }, CorrectionFileView>("getCorrection", { fileId: file.id }));
    } catch {
      setView(null);
    }
    // linkKey carries everything that should trigger a re-read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkKey, relevant]);

  useEffect(() => {
    load();
  }, [load]);

  const run = (key: string, act: Act) => async () => {
    setBusy(key);
    setError(null);
    try {
      await act();
      await load();
    } catch (err) {
      setError(t("failed", { message: (err as Error)?.message ?? String(err) }));
    } finally {
      setBusy(null);
    }
  };
  const link = (originalFileId: string) =>
    callFunction("linkCorrection", { fileId: file.id, originalFileId });
  const unlink = (originalFileId?: string) =>
    callFunction("unlinkCorrection", originalFileId ? { fileId: file.id, originalFileId } : { fileId: file.id });

  if (!view) return null;
  const isCorrection = view.kind === "invoice-correction" || !!view.link;
  if (!isCorrection && view.correctedBy.length === 0) return null;

  return (
    <section className="rounded-md border bg-muted/40 p-3 space-y-2" data-testid="file-correction">
      {isCorrection ? (
        <>
          <div className="flex items-center gap-2 text-sm">
            <FileMinus className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="font-medium">{t("label")}</span>
            {view.referencedInvoiceNumber ? (
              <span className="text-xs text-muted-foreground truncate">
                {t("referencedNumber", { number: view.referencedInvoiceNumber })}
              </span>
            ) : null}
          </div>

          {view.signalsDisagree ? (
            <p className="flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-400">
              <TriangleAlert className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              {t("signalsDisagree")}
            </p>
          ) : null}

          {view.link && view.original ? (
            <LinkedOriginal
              view={view}
              busy={busy}
              onUnlink={run("unlink", () => unlink())}
            />
          ) : (
            <p className="text-xs text-muted-foreground">{t("unlinkedExplanation")}</p>
          )}

          {!view.link && view.suggestions.length > 0 ? (
            <div className="space-y-1">
              <p className="text-xs font-medium">{t("suggestionsTitle")}</p>
              <ul className="space-y-1">
                {view.suggestions.map((s) => (
                  <li key={s.fileId} className="flex items-center gap-2 text-sm">
                    <Link href={`/files?id=${s.fileId}`} className="truncate hover:underline flex-1">
                      {s.invoiceNumber || s.fileName || s.fileId}
                    </Link>
                    {s.amount !== null ? (
                      <span className="text-xs text-muted-foreground tabular-nums">{formatCurrency(s.amount)}</span>
                    ) : null}
                    <Button size="sm" variant="outline" disabled={busy !== null} onClick={run(`accept-${s.fileId}`, () => link(s.fileId))}>
                      <Spinner on={busy === `accept-${s.fileId}`} />
                      {t("accept")}
                    </Button>
                    <Button size="sm" variant="ghost" disabled={busy !== null} onClick={run(`decline-${s.fileId}`, () => unlink(s.fileId))}>
                      <Spinner on={busy === `decline-${s.fileId}`} />
                      {t("decline")}
                    </Button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {!view.link ? (
            <div className="flex items-center gap-2">
              <select
                className="h-8 flex-1 min-w-0 rounded-md border bg-background px-2 text-sm"
                value={chosen}
                onChange={(e) => setChosen(e.target.value)}
                aria-label={t("linkByHand")}
              >
                <option value="">{view.candidates.length > 0 ? t("chooseFile") : t("noCandidates")}</option>
                {view.candidates.map((c) => (
                  <option key={c.fileId} value={c.fileId}>
                    {[c.invoiceNumber || c.fileName || c.fileId, c.date, c.amount !== null ? formatCurrency(c.amount) : null]
                      .filter(Boolean)
                      .join(" · ")}
                  </option>
                ))}
              </select>
              <Button size="sm" variant="outline" disabled={!chosen || busy !== null} onClick={run("manual", () => link(chosen))}>
                <Spinner on={busy === "manual"} />
                {t("linkByHand")}
              </Button>
            </div>
          ) : null}
        </>
      ) : null}

      {view.correctedBy.length > 0 ? (
        <div className="space-y-1">
          <p className="text-xs font-medium">{t("correctedBy")}</p>
          <ul className="space-y-0.5">
            {view.correctedBy.map((c) => (
              <li key={c.fileId} className="flex items-center gap-2 text-sm">
                <FileMinus className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <Link href={`/files?id=${c.fileId}`} className="truncate hover:underline">
                  {c.fileName || c.fileId}
                </Link>
                {c.transactions.map((tx) => (
                  <Link key={tx.id} href={`/transactions?id=${tx.id}`} className="text-xs text-muted-foreground hover:underline tabular-nums">
                    {formatCurrency(tx.amount)}
                  </Link>
                ))}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}

function LinkedOriginal({
  view,
  busy,
  onUnlink,
}: {
  view: CorrectionFileView;
  busy: string | null;
  onUnlink: () => void;
}) {
  const t = useTranslations("files.correction");
  const original = view.original!;
  const setBy = view.link!.setBy;
  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm">
        <span className="text-muted-foreground">{t("corrects")}</span>
        <Link href={`/files?id=${original.fileId}`} className="font-medium truncate hover:underline">
          {original.invoiceNumber || original.fileName || original.fileId}
        </Link>
        {original.paidBy.length > 0 ? (
          <>
            <span className="text-muted-foreground">· {t("paidBy")}</span>
            {original.paidBy.map((tx) => (
              <Link key={tx.id} href={`/transactions?id=${tx.id}`} className="hover:underline tabular-nums">
                {[tx.date, formatCurrency(tx.amount)].filter(Boolean).join(" ")}
              </Link>
            ))}
          </>
        ) : null}
      </div>
      {original.paidBy.length === 0 ? <p className="text-xs text-destructive">{t("notPaid")}</p> : null}
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground flex-1">{t(SET_BY_KEY[setBy])}</span>
        {setBy === "issued-correction" ? null : (
          <Button size="sm" variant="ghost" disabled={busy !== null} onClick={onUnlink}>
            <Spinner on={busy === "unlink"} />
            {t("unlink")}
          </Button>
        )}
      </div>
    </div>
  );
}

type SetByKey = "linkedAuto" | "linkedSuggested" | "linkedManual" | "linkedIssued";
type SetByKeys = Record<"auto" | "suggested-accepted" | "manual" | "issued-correction", SetByKey>;
const SET_BY_KEY: SetByKeys = {
  auto: "linkedAuto",
  "suggested-accepted": "linkedSuggested",
  manual: "linkedManual",
  "issued-correction": "linkedIssued",
};

function Spinner({ on }: { on: boolean }) {
  if (!on) return null;
  return <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />;
}
