"use client";

/**
 * The Receipt Link of a File in its detail panel (#571, ADR-0012): on a
 * Receipt, the invoice it pays with Unlink; on an invoice, its Receipts; the
 * suggested pairs with accept, decline and, at a tie, a choice of which File
 * is the Receipt. Renders nothing for a File with none of these. The
 * "Receipt for…" link by hand is a dialog, opened from the panel's More menu.
 *
 * The view comes from the getReceiptLink callable, the same one the MCP and
 * chat tools read, so every surface shows the same link.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Loader2, ReceiptText } from "lucide-react";
import { TaxFile } from "@/types/file";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { callFunction } from "@/lib/firebase/callable";
import { formatCurrency } from "@/lib/utils";
import type { ReceiptLinkSetBy, ReceiptLinkView, ReceiptPairFileRef } from "@/types/receipt-link";

/** A link act; written as a call signature so the string lint (#168) does not read the generic as copy. */
type Act = { (): Promise<unknown> };

type SetByKey = "linkedAuto" | "linkedSuggested" | "linkedManual";
type SetByKeys = Record<ReceiptLinkSetBy, SetByKey>;
const SET_BY_KEY: SetByKeys = {
  auto: "linkedAuto",
  "suggested-accepted": "linkedSuggested",
  manual: "linkedManual",
};

function isReceiptLinkView(value: unknown): value is ReceiptLinkView {
  const v = value as Partial<ReceiptLinkView> | null | undefined;
  return (
    !!v &&
    Array.isArray(v.receipts) &&
    Array.isArray(v.suggestions) &&
    Array.isArray(v.candidates)
  );
}

function refLabel(ref: ReceiptPairFileRef): string {
  return ref.invoiceNumber || ref.fileName || ref.fileId;
}

interface FileReceiptLinkSectionProps {
  file: TaxFile;
  /** The "Receipt for…" dialog, opened from the panel's More menu. */
  pickerOpen: boolean;
  onPickerOpenChange: (open: boolean) => void;
}

export function FileReceiptLinkSection({ file, pickerOpen: picking, onPickerOpenChange }: FileReceiptLinkSectionProps) {
  const t = useTranslations("files.receiptLink");
  const [view, setView] = useState(null as ReceiptLinkView | null);
  const [busy, setBusy] = useState(null as string | null);
  const [error, setError] = useState(null as string | null);
  const setPicking = onPickerOpenChange;
  const [chosen, setChosen] = useState("");

  // Re-read whenever the stored link, the suggestions or the Connections change under the panel.
  const linkKey = [
    file.id,
    file.receiptLink?.fileId ?? "",
    file.receiptPairSuggestions?.length ?? 0,
    (file.transactionIds ?? []).join(","),
    picking ? "pick" : "",
  ].join("|");

  const load = useCallback(async () => {
    try {
      const reply = await callFunction<{ fileId: string; withCandidates: boolean }, ReceiptLinkView>("getReceiptLink", {
        fileId: file.id,
        withCandidates: picking,
      });
      // Only a well-formed view is drawn: a reply without its lists renders nothing.
      setView(isReceiptLinkView(reply) ? reply : null);
    } catch {
      setView(null);
    }
    // linkKey carries everything that should trigger a re-read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkKey]);

  useEffect(() => {
    load();
  }, [load]);

  const run = (key: string, act: Act) => async () => {
    setBusy(key);
    setError(null);
    try {
      await act();
      setPicking(false);
      setChosen("");
      await load();
    } catch (err) {
      setError(t("failed", { message: (err as Error)?.message ?? String(err) }));
    } finally {
      setBusy(null);
    }
  };
  const link = (receiptId: string, invoiceFileId: string) =>
    callFunction("linkReceipt", { fileId: receiptId, invoiceFileId });
  const unlink = (otherFileId?: string) =>
    callFunction("unlinkReceipt", otherFileId ? { fileId: file.id, otherFileId } : { fileId: file.id });

  if (!view || file.isNotInvoice) return null;
  const hasPair = !!view.link || view.receipts.length !== 0;
  const quiet = !hasPair && view.suggestions.length === 0;

  return (
    <>
    <Dialog
      open={picking}
      onOpenChange={(open) => {
        setPicking(open);
        if (!open) setChosen("");
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("dialogTitle")}</DialogTitle>
          <DialogDescription>{t("countsOnce")}</DialogDescription>
        </DialogHeader>
        {hasPair ? (
          <p className="text-sm text-muted-foreground">{t("alreadyLinked")}</p>
        ) : (
          <select
            className="h-9 w-full rounded-md border bg-background px-2 text-sm"
            value={chosen}
            onChange={(e) => setChosen(e.target.value)}
            aria-label={t("chooseInvoice")}
          >
            <option value="">{view.candidates.length > 0 ? t("chooseInvoice") : t("noCandidates")}</option>
            {view.candidates.map((c) => (
              <option key={c.fileId} value={c.fileId}>
                {[refLabel(c), c.date, c.amount !== null ? formatCurrency(c.amount) : null].filter(Boolean).join(" · ")}
              </option>
            ))}
          </select>
        )}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" onClick={() => setPicking(false)}>
            {t("cancel")}
          </Button>
          {hasPair ? null : (
            <Button disabled={!chosen || busy !== null} onClick={run("manual", () => link(file.id, chosen))}>
              <Spinner on={busy === "manual"} />
              {t("link")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
    {quiet ? null : (
      <section className="rounded-md border bg-muted/40 p-3 space-y-2" data-testid="file-receipt-link">
        {view.link && view.invoice ? (
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm">
              <ReceiptText className="h-4 w-4 text-muted-foreground shrink-0" />
              <span className="text-muted-foreground">{t("receiptFor")}</span>
              <Link href={`/files?id=${view.invoice.fileId}`} className="font-medium truncate hover:underline">
                {refLabel(view.invoice)}
              </Link>
            </div>
            <p className="text-xs text-muted-foreground">{t("countsOnce")}</p>
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground flex-1">{t(SET_BY_KEY[view.link.setBy])}</span>
              <Button size="sm" variant="ghost" disabled={busy !== null} onClick={run("unlink", () => unlink())}>
                <Spinner on={busy === "unlink"} />
                {t("unlink")}
              </Button>
            </div>
          </div>
        ) : null}

        {view.receipts.length > 0 ? (
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("receiptsTitle")}</p>
            <ul className="space-y-0.5">
              {view.receipts.map((r) => (
                <li key={r.fileId} className="flex items-center gap-2 text-sm">
                  <ReceiptText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <Link href={`/files?id=${r.fileId}`} className="truncate hover:underline flex-1">
                    {r.fileName || r.fileId}
                  </Link>
                  <Amount item={r} />
                  <Button size="sm" variant="ghost" disabled={busy !== null} onClick={run(`unlink-${r.fileId}`, () => unlink(r.fileId))}>
                    <Spinner on={busy === `unlink-${r.fileId}`} />
                    {t("unlink")}
                  </Button>
                </li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">{t("countsOnce")}</p>
          </div>
        ) : null}

        {view.suggestions.length > 0 ? (
          <div className="space-y-1">
            <p className="text-xs font-medium">{t("suggestionsTitle")}</p>
            <ul className="space-y-1.5">
              {view.suggestions.map((s) => (
                <Suggestion
                  key={s.fileId}
                  fileId={file.id}
                  suggestion={s}
                  busy={busy}
                  onLink={(receiptId, invoiceId) => run(`accept-${s.fileId}`, () => link(receiptId, invoiceId))()}
                  onDecline={run(`decline-${s.fileId}`, () => unlink(s.fileId))}
                />
              ))}
            </ul>
          </div>
        ) : null}

        {error && !picking ? <p className="text-xs text-destructive">{error}</p> : null}
      </section>
    )}
    </>
  );
}

/** One suggested pair: the other File, and which of the two is the Receipt. */
function Suggestion({
  fileId,
  suggestion,
  busy,
  onLink,
  onDecline,
}: {
  fileId: string;
  suggestion: ReceiptLinkView["suggestions"][number];
  busy: string | null;
  onLink: (receiptId: string, invoiceId: string) => void;
  onDecline: () => void;
}) {
  const t = useTranslations("files.receiptLink");
  const [receiptId, setReceiptId] = useState(suggestion.suggestedReceiptId ?? "");
  const other = suggestion.fileId;
  const invoiceId = receiptId === fileId ? other : fileId;
  return (
    <li className="space-y-1">
      <div className="flex items-center gap-2 text-sm">
        <Link href={`/files?id=${other}`} className="truncate hover:underline flex-1">
          {refLabel(suggestion)}
        </Link>
        <Amount item={suggestion} />
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <select
          className="h-8 flex-1 min-w-0 rounded-md border bg-background px-2 text-xs"
          value={receiptId}
          onChange={(e) => setReceiptId(e.target.value)}
          aria-label={t("pickRole")}
        >
          {suggestion.suggestedReceiptId ? null : <option value="">{t("pickRole")}</option>}
          <option value={fileId}>{t("thisIsReceipt")}</option>
          <option value={other}>{t("otherIsReceipt")}</option>
        </select>
        <Button size="sm" variant="outline" disabled={!receiptId || busy !== null} onClick={() => onLink(receiptId, invoiceId)}>
          <Spinner on={busy === `accept-${other}`} />
          {t("accept")}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={onDecline}>
          <Spinner on={busy === `decline-${other}`} />
          {t("decline")}
        </Button>
      </div>
    </li>
  );
}

function Amount({ item }: { item: ReceiptPairFileRef }) {
  if (item.amount === null) return null;
  return <span className="text-xs text-muted-foreground tabular-nums">{formatCurrency(item.amount, item.currency ?? "EUR")}</span>;
}

function Spinner({ on }: { on: boolean }) {
  if (!on) return null;
  return <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />;
}
