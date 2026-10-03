"use client";

/**
 * What was filed for a period, and whether a later run moved it (#564,
 * D11-D17): the blockers that keep a period from being filed, Mark as filed
 * with the figures editable to match a hand-corrected filing, filed vs now
 * per Kennzahl with the Transactions that moved them, and earlier filed
 * periods whose figures moved.
 *
 * FiBuKI informs here and never files: whether to file a corrected UVA is the
 * User's and the Tax Advisor's decision.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { CircleCheck, Loader2, TriangleAlert } from "lucide-react";
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
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { callFunction } from "@/lib/firebase/callable";
import { formatCurrency } from "@/lib/utils";
import type { ReportPeriod } from "@/types/report";
import type { UvaReportResult } from "@/functions/src/uva/types";
import type { FilingBlocker } from "@/functions/src/uva/filing";
import type { FiledComparison, UvaFiledRecord } from "@/functions/src/uva/filedRecord";

type StoredRecord = Omit<UvaFiledRecord, "filedAt"> & { id: string; filedAt: string };

interface FiledStatus {
  periodKey: string;
  blockers: FilingBlocker[];
  filed: { latest: StoredRecord; comparison: FiledComparison; history: StoredRecord[] } | null;
  earlierFiledMoved: FiledComparison[];
}

/** Blockers with their own guidance; any other shows its detail. */
const GUIDED = new Set(["correction-unlinked", "correction-over-cap"]);

export function UvaFilingPanel({ period, result }: { period: ReportPeriod; result: UvaReportResult }) {
  const t = useTranslations("uvaReview.filing");
  const [status, setStatus] = useState(null as FiledStatus | null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null as string | null);
  const [open, setOpen] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await callFunction<{ period: ReportPeriod }, FiledStatus>("getUvaFiledStatus", { period }));
    } catch (err) {
      setError(t("failed", { message: (err as Error)?.message ?? String(err) }));
    } finally {
      setLoading(false);
    }
    // The result changes when the period is recalculated; re-read then too.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [period.year, period.period, period.type, result]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <Card data-testid="uva-filing-panel">
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        {loading && !status ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        {status ? (
          <>
            <Blockers blockers={status.blockers} />
            <FiledState status={status} />
            <EarlierMoved comparisons={status.earlierFiledMoved} />
            <div className="flex items-center gap-2">
              <Button size="sm" disabled={status.blockers.length > 0} onClick={() => setOpen(true)}>
                {status.filed ? t("markFiledAgain") : t("markFiled")}
              </Button>
              {status.blockers.length > 0 ? (
                <span className="text-xs text-muted-foreground">{t("blockedHint")}</span>
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">{t("decisionIsYours")}</p>
          </>
        ) : null}

        <MarkFiledDialog
          open={open}
          onOpenChange={setOpen}
          period={period}
          result={result}
          onDone={load}
        />
      </CardContent>
    </Card>
  );
}

function Blockers({ blockers }: { blockers: FilingBlocker[] }) {
  const t = useTranslations("uvaReview.filing");
  if (blockers.length === 0) return null;
  return (
    <div className="rounded-md border border-destructive/40 p-3 space-y-1">
      <p className="flex items-center gap-1.5 font-medium text-destructive">
        <TriangleAlert className="h-4 w-4" />
        {t("blockersTitle", { count: blockers.length })}
      </p>
      <ul className="list-disc pl-5 space-y-0.5 text-xs">
        {blockers.map((b, i) => (
          <li key={`${b.code}-${i}`}>
            {GUIDED.has(b.code) ? t(`blocker.${b.code}`) : b.code}
            <span className="block text-muted-foreground">{b.detail}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function FiledState({ status }: { status: FiledStatus }) {
  const t = useTranslations("uvaReview.filing");
  if (!status.filed) return <p className="text-muted-foreground">{t("notFiled")}</p>;
  const { latest, comparison, history } = status.filed;
  return (
    <div className="space-y-2">
      <p className="flex items-center gap-1.5">
        <CircleCheck className="h-4 w-4 text-muted-foreground" />
        {t(latest.source === "finanzonline" ? "filedViaFinanzOnline" : "filedOn", {
          date: latest.filedAt.slice(0, 10),
        })}
        {latest.editedByHand ? <span className="text-xs text-muted-foreground">{t("editedByHand")}</span> : null}
        {history.length > 1 ? (
          <span className="text-xs text-muted-foreground">{t("history", { count: history.length })}</span>
        ) : null}
      </p>
      {comparison.moved ? <Comparison comparison={comparison} /> : <p className="text-xs text-muted-foreground">{t("unchanged")}</p>}
    </div>
  );
}

function Comparison({ comparison }: { comparison: FiledComparison }) {
  const t = useTranslations("uvaReview.filing");
  return (
    <div className="space-y-2">
      <p className={comparison.balanceMoved ? "text-destructive text-xs" : "text-xs"}>
        {comparison.balanceMoved
          ? t("balanceMoved", { delta: formatCurrency(comparison.balanceDelta) })
          : t("onlyMoved")}
      </p>
      <table className="w-full text-xs tabular-nums">
        <thead>
          <tr className="text-muted-foreground">
            <th className="text-left font-normal">{t("kz")}</th>
            <th className="text-right font-normal">{t("filed")}</th>
            <th className="text-right font-normal">{t("now")}</th>
            <th className="text-right font-normal">{t("delta")}</th>
          </tr>
        </thead>
        <tbody>
          {comparison.deltas.map((d) => (
            <tr key={d.code}>
              <td className="font-mono">{d.code}</td>
              <td className="text-right">{formatCurrency(d.filed)}</td>
              <td className="text-right">{formatCurrency(d.now)}</td>
              <td className="text-right">{formatCurrency(d.delta)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {comparison.transactions.length > 0 ? (
        <div className="space-y-0.5">
          <p className="text-xs font-medium">{t("movedBy")}</p>
          <ul className="text-xs space-y-0.5">
            {comparison.transactions.map((m) => (
              <li key={m.transactionId} className="flex gap-2">
                <Link href={`/transactions?id=${m.transactionId}`} className="hover:underline truncate">
                  {[m.date, m.partner].filter(Boolean).join(" · ")}
                </Link>
                <span className="ml-auto text-muted-foreground">
                  {t("movedVat", {
                    input: formatCurrency(m.inputVatDelta),
                    output: formatCurrency(m.outputVatDelta),
                  })}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function EarlierMoved({ comparisons }: { comparisons: FiledComparison[] }) {
  const t = useTranslations("uvaReview.filing");
  if (comparisons.length === 0) return null;
  return (
    <div className="rounded-md border border-amber-500/40 p-3 space-y-1">
      <p className="font-medium">{t("earlierTitle")}</p>
      <ul className="text-xs space-y-0.5">
        {comparisons.map((c) => (
          <li key={c.periodKey}>
            {c.balanceMoved
              ? t("earlierBalance", { period: c.periodKey, delta: formatCurrency(c.balanceDelta) })
              : t("earlierOnlyMoved", { period: c.periodKey, count: c.deltas.length })}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Cents as the euro figure a person types, "1234.56". */
function toEuroInput(cents: number): string {
  return (cents / 100).toFixed(2);
}

/** A typed euro figure back to cents; null when it is not a number. */
function fromEuroInput(text: string): number | null {
  const n = Number(text.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}

function MarkFiledDialog({
  open,
  onOpenChange,
  period,
  result,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  period: ReportPeriod;
  result: UvaReportResult;
  onDone: () => void;
}) {
  const t = useTranslations("uvaReview.filing");
  const calculated = useMemo(() => {
    const out: Array<[string, number]> = Object.entries(result.kennzahlen).map(([code, f]) => [code, f.value]);
    return out.sort(([a], [b]) => a.localeCompare(b));
  }, [result]);
  const [values, setValues] = useState({} as Record<string, string>);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null as string | null);

  useEffect(() => {
    if (open) {
      setValues(Object.fromEntries(calculated.map(([code, cents]) => [code, toEuroInput(cents)])));
      setNote("");
      setError(null);
    }
  }, [open, calculated]);

  const submit = async () => {
    const kennzahlen: Record<string, number> = {};
    for (const [code, text] of Object.entries(values)) {
      const cents = fromEuroInput(text);
      if (cents === null) {
        setError(t("notANumber", { code }));
        return;
      }
      kennzahlen[code] = cents;
    }
    setBusy(true);
    setError(null);
    try {
      await callFunction("markUvaPeriodFiled", { period, kennzahlen, ...(note.trim() ? { note: note.trim() } : {}) });
      onOpenChange(false);
      onDone();
    } catch (err) {
      setError(t("failed", { message: (err as Error)?.message ?? String(err) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("dialogTitle")}</DialogTitle>
          <DialogDescription>{t("dialogDescription")}</DialogDescription>
        </DialogHeader>
        <div className="max-h-80 overflow-y-auto space-y-1.5">
          {calculated.map(([code]) => (
            <label key={code} className="flex items-center gap-3 text-sm">
              <span className="w-16 font-mono text-xs text-muted-foreground">{t("kzCode", { code })}</span>
              <Input
                className="h-8 text-right tabular-nums"
                inputMode="decimal"
                value={values[code] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [code]: e.target.value }))}
              />
            </label>
          ))}
          <label className="flex flex-col gap-1 text-sm pt-2">
            <span className="text-xs text-muted-foreground">{t("note")}</span>
            <Input value={note} onChange={(e) => setNote(e.target.value)} />
          </label>
        </div>
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("cancel")}
          </Button>
          <Button onClick={submit} disabled={busy}>
            {busy ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
