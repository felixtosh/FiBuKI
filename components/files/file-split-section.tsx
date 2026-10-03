"use client";

/**
 * Split in the File detail panel (#550): the suggestion the Extraction stored
 * when it read several separately issued invoices or Receipts in one PDF,
 * the dialog that sets the page ranges, and the links between a split
 * original and its parts.
 *
 * Every rule lives in the splitFile callable, the same operation the
 * split_file tool runs; this only collects the ranges and shows its refusal.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Loader2, Plus, Scissors, X } from "lucide-react";
import { TaxFile, SplitSegment } from "@/types/file";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { callFunction } from "@/lib/firebase/callable";
import { getFile } from "@/lib/operations";
import type { OperationsContext } from "@/lib/operations/types";
import { formatCurrency } from "@/lib/utils";

interface Range {
  from: number;
  to: number;
}

type NameById = Record<string, string>;

/** A split act; a call signature so the string lint (#168) does not read the generic as copy. */
type Act = { (): Promise<unknown> };

/** A PDF that is live and not a FiBuKI-generated invoice may be split. */
export function canSplitFile(file: TaxFile): boolean {
  return (
    file.fileType === "application/pdf" &&
    !file.deletedAt &&
    !file.invoiceId &&
    (file.pageCount == null || file.pageCount >= 2)
  );
}

function rangesFromSegments(segments: SplitSegment[]): Range[] {
  return segments.map((s) => ({ from: s.pages[0], to: s.pages[1] }));
}

function defaultRanges(file: TaxFile): Range[] {
  if (file.splitSuggestion) return rangesFromSegments(file.splitSuggestion.segments);
  const count = file.pageCount ?? 2;
  return Array.from({ length: Math.max(count, 2) }, (_, i) => ({ from: i + 1, to: i + 1 }));
}

function PageLabel({ from, to }: Range) {
  const t = useTranslations("files.split");
  return from === to ? t("pageSingle", { page: from }) : t("pageRange", { from, to });
}

export function FileSplitSection({
  file,
  ctx,
  onSplit,
}: {
  file: TaxFile;
  ctx: OperationsContext;
  /** Opens the dialog; the panel owns it so its actions can open it too. */
  onSplit: () => void;
}) {
  const t = useTranslations("files.split");
  const [busy, setBusy] = useState(null as string | null);
  const [error, setError] = useState(null as string | null);
  const [names, setNames] = useState({} as NameById);

  const linkedIds = [file.splitFrom?.fileId, ...(file.splitInto ?? [])].filter(
    (id): id is string => !!id
  );
  const linkedKey = linkedIds.join("|");

  useEffect(() => {
    if (!linkedKey || !ctx.userId) return;
    let cancelled = false;
    Promise.all(linkedKey.split("|").map((id) => getFile(ctx, id))).then((found) => {
      if (cancelled) return;
      const next: NameById = {};
      for (const f of found) if (f) next[f.id] = f.fileName;
      setNames(next);
    });
    return () => {
      cancelled = true;
    };
  }, [linkedKey, ctx]);

  const suggestion = !file.deletedAt && !file.splitInto?.length ? file.splitSuggestion : null;

  const run = (key: string, act: Act) => async () => {
    setBusy(key);
    setError(null);
    try {
      await act();
    } catch (err) {
      setError(t("failed", { message: (err as Error)?.message ?? String(err) }));
    } finally {
      setBusy(null);
    }
  };

  if (!suggestion && !file.splitFrom && !file.splitInto?.length) return null;

  return (
    <section className="rounded-md border bg-muted/40 p-3 space-y-2" data-testid="file-split">
      {suggestion ? (
        <>
          <div className="flex items-center gap-2 text-sm">
            <Scissors className="h-4 w-4 text-muted-foreground shrink-0" />
            <span className="font-medium">
              {t("suggestionTitle", { count: suggestion.segments.length })}
            </span>
          </div>
          <p className="text-xs text-muted-foreground">{t("suggestionExplanation")}</p>
          <ul className="space-y-0.5">
            {suggestion.segments.map((s) => (
              <li key={s.pages[0]} className="flex items-center gap-2 text-sm">
                <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                  <PageLabel from={s.pages[0]} to={s.pages[1]} />
                </span>
                <span className="truncate flex-1">
                  {[s.issuer, s.invoiceNumber].filter(Boolean).join(" · ")}
                </span>
                {s.total !== null ? (
                  <span className="text-xs tabular-nums">{formatCurrency(s.total)}</span>
                ) : null}
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={run("split", () =>
                callFunction("splitFile", {
                  fileId: file.id,
                  ranges: rangesFromSegments(suggestion.segments),
                })
              )}
            >
              <Spinner on={busy === "split"} />
              {t("split")}
            </Button>
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={onSplit}>
              {t("adjust")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={run("dismiss", () => callFunction("dismissSplitSuggestion", { fileId: file.id }))}
            >
              <Spinner on={busy === "dismiss"} />
              {t("notABundle")}
            </Button>
          </div>
        </>
      ) : null}

      {file.splitFrom ? (
        <div className="flex flex-wrap items-center gap-x-1.5 text-sm">
          <Scissors className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
          <span className="text-muted-foreground">{t("splitFrom")}</span>
          <Link href={`/files?id=${file.splitFrom.fileId}`} className="font-medium truncate hover:underline">
            {names[file.splitFrom.fileId] ?? t("theOriginal")}
          </Link>
          <span className="text-xs text-muted-foreground tabular-nums">
            <PageLabel from={file.splitFrom.pages[0]} to={file.splitFrom.pages[1]} />
          </span>
        </div>
      ) : null}

      {file.splitInto?.length ? (
        <div className="space-y-1">
          <p className="text-xs font-medium">{t("splitInto", { count: file.splitInto.length })}</p>
          <ul className="space-y-0.5">
            {file.splitInto.map((id) => (
              <li key={id} className="flex items-center gap-2 text-sm">
                <Scissors className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <Link href={`/files?id=${id}`} className="truncate hover:underline">
                  {names[id] ?? id}
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {error ? <p className="text-xs text-destructive">{error}</p> : null}
    </section>
  );
}

export function SplitFileDialog({
  file,
  open,
  onClose,
}: {
  file: TaxFile;
  open: boolean;
  onClose: () => void;
}) {
  const t = useTranslations("files.split");
  const [ranges, setRanges] = useState(() => defaultRanges(file));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null as string | null);
  const pageCount = file.pageCount ?? file.splitSuggestion?.pageCount ?? null;

  // Start from the suggestion (or one part per page) each time it opens.
  useEffect(() => {
    if (open) {
      setRanges(defaultRanges(file));
      setError(null);
    }
    // Only on open: edits to the ranges must survive a re-render of the File.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, file.id]);

  const update = (index: number, key: keyof Range, value: string) => {
    const page = Number.parseInt(value, 10);
    setRanges((rs) => rs.map((r, i) => (i === index ? { ...r, [key]: Number.isNaN(page) ? 0 : page } : r)));
  };
  const addPart = () =>
    setRanges((rs) => {
      const next = (rs[rs.length - 1]?.to ?? 0) + 1;
      return [...rs, { from: next, to: next }];
    });
  const removePart = (index: number) => setRanges((rs) => rs.filter((_, i) => i !== index));

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await callFunction("splitFile", { fileId: file.id, ranges });
      onClose();
    } catch (err) {
      setError(t("failed", { message: (err as Error)?.message ?? String(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("dialogTitle")}</DialogTitle>
          <DialogDescription>{t("dialogDescription")}</DialogDescription>
        </DialogHeader>

        <p className="text-sm text-muted-foreground">
          {pageCount !== null ? t("pageCount", { count: pageCount }) : t("pageCountUnknown")}
        </p>

        <div className="space-y-2">
          {ranges.map((r, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="w-16 text-sm shrink-0">{t("part", { n: i + 1 })}</span>
              <Input
                type="number"
                min={1}
                max={pageCount ?? undefined}
                value={r.from || ""}
                onChange={(e) => update(i, "from", e.target.value)}
                aria-label={t("fromPage")}
                className="h-8"
              />
              <Input
                type="number"
                min={1}
                max={pageCount ?? undefined}
                value={r.to || ""}
                onChange={(e) => update(i, "to", e.target.value)}
                aria-label={t("toPage")}
                className="h-8"
              />
              <Button
                size="icon"
                variant="ghost"
                className="h-8 w-8 shrink-0"
                disabled={ranges.length <= 2}
                onClick={() => removePart(i)}
                aria-label={t("removePart")}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          <Button size="sm" variant="outline" onClick={addPart}>
            <Plus className="h-4 w-4 mr-1" />
            {t("addPart")}
          </Button>
        </div>

        {error ? <p className="text-sm text-destructive">{error}</p> : null}

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button onClick={submit} disabled={busy}>
            <Spinner on={busy} />
            {t("confirm", { count: ranges.length })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Spinner({ on }: { on: boolean }) {
  return on ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : null;
}
