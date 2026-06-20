"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Check,
  Copy,
  Loader2,
  RefreshCw,
  Send,
  Share2,
  X,
  XCircle,
} from "lucide-react";
import QRCode from "qrcode";
import { doc, onSnapshot } from "firebase/firestore";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { callFunction } from "@/lib/firebase/callable";
import { db } from "@/lib/firebase/config";
import { useInvoice } from "@/hooks/use-invoice";
import {
  DEFAULT_PAYMENT_TERMS,
  Invoice,
  InvoiceLineItem,
  computeInvoiceTotals,
  parsePaymentTermsToDays,
} from "@/types/invoice";
import { TaxFile } from "@/types/file";
import { InvoiceStatusBadge } from "./InvoiceStatusBadge";
import { InvoiceLineItemsTable } from "./InvoiceLineItemsTable";
import {
  InvoiceRecipientField,
  SelectedRecipient,
} from "./InvoiceRecipientField";
import {
  InvoiceIssuerPicker,
  SelectedIssuer,
} from "./InvoiceIssuerPicker";
import { InvoiceShareLinkDialog } from "./InvoiceShareLinkDialog";
import { InvoiceDocument } from "./InvoiceDocument";
import { FilePreview } from "@/components/files/file-preview";
import { buildEpcPayload } from "@/lib/invoicing/epcPayload";

interface InvoiceDetailPanelProps {
  invoiceId: string;
  /** Optional file id (set once the invoice has been issued and the file exists). */
  fileId?: string | null;
  onClose: () => void;
  /**
   * Optional lift-up handler. When provided, the panel reports its current
   * preview source (downloadUrl + fileName + fileType) so the page can render
   * the standard `FileViewerOverlay` over the file list area. The panel still
   * works without this (the parent simply won't be able to open the overlay).
   */
  onPreviewSourceChange?: (
    source: { downloadUrl: string; fileName: string; fileType: string } | null
  ) => void;
  /** Whether the parent-rendered viewer is currently open (for thumbnail active state). */
  viewerOpen?: boolean;
  /** Toggles the parent-rendered viewer. */
  onToggleViewer?: () => void;
}

// Convert Firestore Timestamp-ish to yyyy-MM-dd
function toDateInput(value: unknown): string {
  if (!value) return "";
  const d =
    typeof (value as { toDate?: () => Date }).toDate === "function"
      ? (value as { toDate: () => Date }).toDate()
      : (value as Date);
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function fromDateInput(input: string): Date | undefined {
  if (!input) return undefined;
  const d = new Date(input + "T00:00:00");
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function addDaysToInputDate(input: string, days: number): string {
  const d = fromDateInput(input);
  if (!d) return "";
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatEur(cents: number): string {
  const safe = Math.round(cents);
  const negative = safe < 0;
  const abs = Math.abs(safe);
  const euros = Math.floor(abs / 100);
  const remainder = abs % 100;
  const eurosStr = euros.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}${eurosStr},${String(remainder).padStart(
    2,
    "0"
  )} €`;
}

interface LocalForm {
  issuer: SelectedIssuer | null;
  recipient: SelectedRecipient | null;
  issueDate: string; // yyyy-MM-dd
  paymentTerms: string;
  dueDate: string; // yyyy-MM-dd
  lineItems: InvoiceLineItem[];
  notes: string;
}

function invoiceToForm(invoice: Invoice): LocalForm {
  return {
    issuer: invoice.issuer
      ? { entityId: invoice.issuer.entityId, iban: invoice.issuer.iban }
      : null,
    recipient: invoice.recipient?.partnerId
      ? {
          partnerId: invoice.recipient.partnerId,
          partnerType: invoice.recipient.partnerType,
        }
      : null,
    issueDate: toDateInput(invoice.issueDate),
    paymentTerms: invoice.paymentTerms || DEFAULT_PAYMENT_TERMS,
    dueDate: toDateInput(invoice.dueDate),
    lineItems: invoice.lineItems ?? [],
    notes: invoice.notes ?? "",
  };
}

export function InvoiceDetailPanel({
  invoiceId,
  fileId,
  onClose,
  onPreviewSourceChange,
  viewerOpen = false,
  onToggleViewer,
}: InvoiceDetailPanelProps) {
  const { invoice, loading } = useInvoice(invoiceId);
  const [form, setForm] = useState<LocalForm | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const initRef = useRef(false);

  // Hydrate the local form from the invoice once it loads (and whenever the
  // invoice id changes).
  useEffect(() => {
    if (!invoice) return;
    if (initRef.current && form) return;
    initRef.current = true;
    setForm(invoiceToForm(invoice));
  }, [invoice, form]);

  // Reset hydration when switching invoices
  useEffect(() => {
    initRef.current = false;
    setForm(null);
  }, [invoiceId]);

  const isDraft = invoice?.status === "draft";
  const disabled = !isDraft;

  // ---------------------------------------------------------------------
  // Issued invoice: subscribe to the linked TaxFile so we can show its real
  // downloadUrl in the preview / overlay.
  // ---------------------------------------------------------------------
  const [issuedFile, setIssuedFile] = useState<TaxFile | null>(null);
  useEffect(() => {
    if (!fileId) {
      setIssuedFile(null);
      return;
    }
    const unsub = onSnapshot(
      doc(db, "files", fileId),
      (snap) => {
        if (snap.exists()) {
          setIssuedFile({ id: snap.id, ...snap.data() } as TaxFile);
        } else {
          setIssuedFile(null);
        }
      },
      (err) => {
        console.error("InvoiceDetailPanel issuedFile snapshot error:", err);
        setIssuedFile(null);
      }
    );
    return () => unsub();
  }, [fileId]);

  // Debounced auto-save to updateInvoice while the invoice is a draft
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentRef = useRef<string>("");

  const sendUpdate = useCallback(
    async (next: LocalForm) => {
      if (!invoice || invoice.status !== "draft") return;
      const patch: Record<string, unknown> = {
        paymentTerms: next.paymentTerms,
        lineItems: next.lineItems,
        notes: next.notes,
      };
      if (next.issueDate) {
        patch.issueDate = fromDateInput(next.issueDate)?.toISOString();
      }
      if (next.dueDate) {
        patch.dueDate = fromDateInput(next.dueDate)?.toISOString();
      }
      if (next.recipient) {
        patch.partnerId = next.recipient.partnerId;
        patch.partnerType = next.recipient.partnerType;
      }
      if (next.issuer) {
        patch.issuerEntityId = next.issuer.entityId;
        patch.issuerIban = next.issuer.iban;
      }
      const snapshot = JSON.stringify(patch);
      if (snapshot === lastSentRef.current) return;
      lastSentRef.current = snapshot;
      try {
        await callFunction<
          { invoiceId: string; patch: Record<string, unknown> },
          { invoiceId: string; status: string }
        >("updateInvoice", { invoiceId, patch });
      } catch (err) {
        console.error("updateInvoice failed:", err);
      }
    },
    [invoice, invoiceId]
  );

  const queueSave = useCallback(
    (next: LocalForm) => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        sendUpdate(next);
      }, 500);
    },
    [sendUpdate]
  );

  // Cleanup pending save on unmount
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  // ---------------------------------------------------------------------
  // Phantom draft cleanup: when the panel unmounts (close, navigate away,
  // invoice id changes), delete the underlying invoice if it's still an
  // empty draft. We always read the most recent invoice/form via refs so
  // the cleanup callback doesn't capture stale state.
  // ---------------------------------------------------------------------
  const invoiceRef = useRef<Invoice | null>(null);
  const formRef = useRef<LocalForm | null>(null);
  useEffect(() => {
    invoiceRef.current = invoice ?? null;
  }, [invoice]);
  useEffect(() => {
    formRef.current = form;
  }, [form]);

  useEffect(() => {
    const idAtMount = invoiceId;
    return () => {
      const inv = invoiceRef.current;
      const f = formRef.current;
      // Only act on the invoice this effect was tied to.
      if (!inv || inv.id !== idAtMount) return;
      if (inv.status !== "draft") return;

      // "Empty" definition: prefer the local form state if available
      // (captures unflushed edits), otherwise fall back to the persisted
      // invoice document.
      const lineItems = f?.lineItems ?? inv.lineItems ?? [];
      const allItemsEmpty =
        lineItems.length === 0 ||
        lineItems.every(
          (li) => !li.description?.trim() && (li.unitPrice ?? 0) === 0
        );
      const recipientPartnerId = f?.recipient?.partnerId ?? inv.recipient?.partnerId ?? "";
      const notesValue = (f?.notes ?? inv.notes ?? "").trim();
      const isEmpty =
        allItemsEmpty && recipientPartnerId === "" && notesValue === "";

      if (!isEmpty) return;

      // Cancel any pending debounced save BEFORE deleting so we don't
      // race the autosave back into a freshly-deleted doc.
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }

      // Fire-and-forget: swallow errors silently (the invoice may have
      // already been issued, deleted, or otherwise transitioned out of
      // draft state in the meantime).
      callFunction<{ invoiceId: string }, { success: boolean }>(
        "deleteInvoice",
        { invoiceId: idAtMount }
      ).catch(() => undefined);
    };
  }, [invoiceId]);

  const updateForm = useCallback(
    (patch: Partial<LocalForm>) => {
      setForm((prev) => {
        if (!prev) return prev;
        const next = { ...prev, ...patch };
        // Auto-recompute due date when issueDate or paymentTerms change
        if ("issueDate" in patch || "paymentTerms" in patch) {
          const days = parsePaymentTermsToDays(next.paymentTerms);
          if (next.issueDate) {
            next.dueDate = addDaysToInputDate(next.issueDate, days);
          }
        }
        queueSave(next);
        return next;
      });
    },
    [queueSave]
  );

  // Live totals (preview will reflect them via onSnapshot once saved)
  const liveTotals = useMemo(() => {
    if (!form) return { subtotal: 0, vatAmount: 0, total: 0 };
    return computeInvoiceTotals(form.lineItems);
  }, [form]);

  // ---------------------------------------------------------------------
  // Live PDF preview (drafts only)
  //
  // We render the React-PDF document to a Blob, then create an object URL so
  // it can be passed to <FilePreview> (thumbnail) and <FileViewerOverlay>
  // (full overlay). The rendering is debounced ~300ms to avoid thrashing
  // while the user is typing.
  // ---------------------------------------------------------------------
  const [draftBlobUrl, setDraftBlobUrl] = useState<string | null>(null);
  const [draftRendering, setDraftRendering] = useState(false);
  const previousBlobUrlRef = useRef<string | null>(null);
  const renderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const livePreviewInvoice: Invoice | null = useMemo(() => {
    if (!invoice || !form) return null;
    return {
      ...invoice,
      lineItems: form.lineItems,
      notes: form.notes,
      ...computeInvoiceTotals(form.lineItems),
    };
  }, [invoice, form]);

  useEffect(() => {
    // Only generate live blob URLs for drafts
    if (!isDraft || !livePreviewInvoice) {
      return;
    }

    let cancelled = false;
    if (renderTimerRef.current) clearTimeout(renderTimerRef.current);
    setDraftRendering(true);

    renderTimerRef.current = setTimeout(async () => {
      try {
        // Generate EPC QR if we have an IBAN
        let qrDataUrl: string | undefined;
        const iban = livePreviewInvoice.issuer?.iban;
        if (iban) {
          const epc = buildEpcPayload({
            bic: livePreviewInvoice.issuer?.bic,
            name: livePreviewInvoice.issuer?.name ?? "",
            iban,
            amountCents: livePreviewInvoice.total ?? 0,
            remittance: livePreviewInvoice.number
              ? `Rechnung ${livePreviewInvoice.number}`
              : undefined,
          });
          try {
            qrDataUrl = await QRCode.toDataURL(epc, { margin: 0, width: 256 });
          } catch (err) {
            console.warn("EPC QR generation failed:", err);
          }
        }

        // Dynamic import to keep @react-pdf/renderer out of the initial bundle
        const { pdf } = await import("@react-pdf/renderer");
        const blob = await pdf(
          <InvoiceDocument
            invoice={livePreviewInvoice}
            qrDataUrl={qrDataUrl}
          />
        ).toBlob();
        if (cancelled) return;

        const url = URL.createObjectURL(blob);
        // Revoke the previous URL after we set the new one, so any consumers
        // currently displaying the old URL aren't left with a dangling ref
        // mid-frame.
        const prev = previousBlobUrlRef.current;
        previousBlobUrlRef.current = url;
        setDraftBlobUrl(url);
        setDraftRendering(false);
        if (prev) {
          // Small delay to let consumers swap to the new URL
          setTimeout(() => URL.revokeObjectURL(prev), 0);
        }
      } catch (err) {
        if (!cancelled) {
          console.error("Live invoice PDF render failed:", err);
          setDraftRendering(false);
        }
      }
    }, 300);

    return () => {
      cancelled = true;
      if (renderTimerRef.current) clearTimeout(renderTimerRef.current);
    };
  }, [isDraft, livePreviewInvoice]);

  // Cleanup blob URL on unmount
  useEffect(() => {
    return () => {
      if (previousBlobUrlRef.current) {
        URL.revokeObjectURL(previousBlobUrlRef.current);
        previousBlobUrlRef.current = null;
      }
    };
  }, []);

  // ---------------------------------------------------------------------
  // Active preview source — draft blob for drafts, issued file URL otherwise.
  // ---------------------------------------------------------------------
  const previewSource = useMemo(() => {
    if (isDraft) {
      if (!draftBlobUrl) return null;
      const fileName = invoice?.number
        ? `Rechnung-${invoice.number}.pdf`
        : "Rechnungsentwurf.pdf";
      return {
        downloadUrl: draftBlobUrl,
        fileName,
        fileType: "application/pdf",
      };
    }
    if (issuedFile && issuedFile.downloadUrl) {
      return {
        downloadUrl: issuedFile.downloadUrl,
        fileName: issuedFile.fileName,
        fileType: issuedFile.fileType || "application/pdf",
      };
    }
    return null;
  }, [isDraft, draftBlobUrl, invoice?.number, issuedFile]);

  // Lift preview source up to the page so it can render the standard
  // FileViewerOverlay over the file list area.
  useEffect(() => {
    onPreviewSourceChange?.(previewSource);
  }, [onPreviewSourceChange, previewSource]);

  // Clear the lifted state on unmount.
  useEffect(() => {
    return () => {
      onPreviewSourceChange?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -----------------------------------------------------------------
  // Action handlers
  // -----------------------------------------------------------------

  const doAction = useCallback(
    async (name: string, fn: () => Promise<void>) => {
      setActionBusy(name);
      try {
        await fn();
      } catch (err) {
        console.error(`${name} failed:`, err);
      } finally {
        setActionBusy(null);
      }
    },
    []
  );

  const handleIssue = () =>
    doAction("issue", async () => {
      // Flush pending edits first
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        if (form) await sendUpdate(form);
      }
      await callFunction<
        { invoiceId: string; createShareLink?: boolean },
        { invoiceId: string; fileId: string; downloadUrl: string }
      >("issueInvoice", { invoiceId });
    });

  const handleCancel = () =>
    doAction("cancel", async () => {
      await callFunction<
        { invoiceId: string },
        { invoiceId: string; status: string }
      >("cancelInvoice", { invoiceId });
    });

  const handleDuplicate = () =>
    doAction("duplicate", async () => {
      const res = await callFunction<
        { invoiceId: string },
        { invoiceId: string; fileId?: string }
      >("duplicateInvoice", { invoiceId });
      // Navigate to the new draft via its file row so it highlights in the
      // list. Falls back to ?invoiceId= for legacy responses without fileId.
      if (res.invoiceId && typeof window !== "undefined") {
        const params = new URLSearchParams(window.location.search);
        if (res.fileId) {
          params.set("id", res.fileId);
          params.delete("invoiceId");
        } else {
          params.set("invoiceId", res.invoiceId);
          params.delete("id");
        }
        window.history.pushState({}, "", `/files?${params.toString()}`);
      }
    });

  const handleRegen = () =>
    doAction("regen", async () => {
      await callFunction<
        { invoiceId: string },
        { downloadUrl: string }
      >("regenerateInvoicePdf", { invoiceId });
    });

  // -----------------------------------------------------------------
  // Loading state
  // -----------------------------------------------------------------

  if (loading || !invoice || !form) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <>
      <div className="h-full flex flex-col">
        {/* Header — status + invoice number + close. All actions live in the
            sticky footer below (mirrors partner-detail-panel). */}
        <div className="flex items-center justify-between gap-2 h-[53px] border-b px-4 flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <h2 className="text-sm font-semibold truncate">
              Rechnung {invoice.number || "(Entwurf)"}
            </h2>
            <InvoiceStatusBadge status={invoice.status} />
          </div>
          <Button
            size="icon"
            variant="ghost"
            onClick={onClose}
            className="h-8 w-8"
            title="Schließen"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        {/* Body: single-column editor with embedded preview thumbnail */}
        <ScrollArea className="flex-1">
          <div className="p-4 space-y-4">
            {/* Preview thumbnail row — mirrors file-detail-panel's layout */}
            <div className="flex gap-4 file-preview-section">
              <div className="w-1/4 flex-shrink-0 file-preview-thumb">
                {previewSource ? (
                  <>
                    <FilePreview
                      downloadUrl={previewSource.downloadUrl}
                      fileType={previewSource.fileType}
                      fileName={previewSource.fileName}
                      onClick={onToggleViewer}
                      active={viewerOpen}
                    />
                    <p className="text-xs text-muted-foreground text-center mt-1">
                      {draftRendering
                        ? "Aktualisiere…"
                        : viewerOpen
                          ? "Klicken zum Schließen"
                          : "Klicken zum Öffnen"}
                    </p>
                  </>
                ) : (
                  <div className="aspect-[3/4] rounded-md border border-dashed bg-muted/30 flex flex-col items-center justify-center text-xs text-muted-foreground gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Vorschau wird erstellt…
                  </div>
                )}
              </div>
              <div className="flex-1 space-y-2 text-sm">
                <div className="text-xs text-muted-foreground uppercase tracking-wider">
                  {isDraft ? "Entwurf" : "Rechnung"}
                </div>
                <div className="text-base font-semibold truncate">
                  {invoice.number || "(Entwurf)"}
                </div>
                {invoice.recipient?.name && (
                  <div className="text-muted-foreground truncate">
                    {invoice.recipient.name}
                  </div>
                )}
                <div className="tabular-nums font-medium">
                  {formatEur(liveTotals.total)}
                </div>
              </div>
            </div>

            <Separator />

            <InvoiceIssuerPicker
              value={form.issuer}
              onChange={(issuer) => updateForm({ issuer })}
              disabled={disabled}
            />

            <InvoiceRecipientField
              value={form.recipient}
              onChange={(recipient) => updateForm({ recipient })}
              disabled={disabled}
            />

            <Separator />

            <div className="grid grid-cols-3 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  Rechnungsdatum
                </Label>
                <Input
                  type="date"
                  value={form.issueDate}
                  onChange={(e) =>
                    updateForm({ issueDate: e.target.value })
                  }
                  disabled={disabled}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  Zahlungsfrist
                </Label>
                <Input
                  value={form.paymentTerms}
                  onChange={(e) =>
                    updateForm({ paymentTerms: e.target.value })
                  }
                  disabled={disabled}
                  placeholder={DEFAULT_PAYMENT_TERMS}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">
                  Fällig am
                </Label>
                <Input
                  type="date"
                  value={form.dueDate}
                  onChange={(e) =>
                    updateForm({ dueDate: e.target.value })
                  }
                  disabled={disabled}
                />
              </div>
            </div>

            <Separator />

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">
                Positionen
              </Label>
              <InvoiceLineItemsTable
                lineItems={form.lineItems}
                onChange={(lineItems) => updateForm({ lineItems })}
                disabled={disabled}
              />
            </div>

            <div className="space-y-1 text-sm tabular-nums">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Netto</span>
                <span>{formatEur(liveTotals.subtotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">USt.</span>
                <span>{formatEur(liveTotals.vatAmount)}</span>
              </div>
              <div className="flex justify-between font-semibold border-t pt-1 mt-1">
                <span>Gesamt</span>
                <span>{formatEur(liveTotals.total)}</span>
              </div>
            </div>

            <Separator />

            <div className="space-y-1.5">
              <Label className="text-xs text-muted-foreground">
                Notiz
              </Label>
              <textarea
                value={form.notes}
                onChange={(e) => updateForm({ notes: e.target.value })}
                disabled={disabled}
                rows={3}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                placeholder="Optionaler Hinweis am Ende der Rechnung…"
              />
            </div>

            {!isDraft && (
              <div className="text-xs text-muted-foreground bg-muted/40 border rounded-md p-2 flex items-start gap-2">
                <Check className="h-3.5 w-3.5 mt-0.5" />
                <span>
                  Diese Rechnung ist nicht mehr editierbar. Dupliziere sie,
                  um einen neuen Entwurf zu erstellen.
                </span>
              </div>
            )}
          </div>
        </ScrollArea>

        {/* Sticky footer actions — mirrors the partner/file detail panel
            pattern (`p-4 border-t` at the bottom of the column). Buttons
            are status-aware. During draft we intentionally show only the
            primary "Ausstellen" action: closing the sidebar auto-deletes
            an empty draft (see phantom-cleanup effect above), so Löschen
            is redundant, and Duplizieren of a half-filled draft is
            confusing. */}
        <div className="flex-shrink-0 border-t bg-background p-4 space-y-2">
          {invoice.status === "draft" && (
            <Button
              className="w-full"
              onClick={handleIssue}
              disabled={actionBusy !== null}
            >
              {actionBusy === "issue" ? (
                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              ) : (
                <Send className="h-4 w-4 mr-2" />
              )}
              Ausstellen
            </Button>
          )}
          {(invoice.status === "issued" || invoice.status === "sent") && (
            <>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setShareOpen(true)}
                disabled={actionBusy !== null}
              >
                <Share2 className="h-4 w-4 mr-2" />
                Teilen
              </Button>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={handleRegen}
                  disabled={actionBusy !== null}
                  title="PDF neu erzeugen"
                >
                  {actionBusy === "regen" ? (
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  ) : (
                    <RefreshCw className="h-4 w-4 mr-2" />
                  )}
                  PDF neu
                </Button>
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={handleDuplicate}
                  disabled={actionBusy !== null}
                >
                  <Copy className="h-4 w-4 mr-2" />
                  Duplizieren
                </Button>
              </div>
              <Button
                variant="outline"
                className="w-full text-destructive hover:text-destructive hover:bg-destructive/10"
                onClick={handleCancel}
                disabled={actionBusy !== null}
              >
                <XCircle className="h-4 w-4 mr-2" />
                Stornieren
              </Button>
            </>
          )}
          {invoice.status === "paid" && (
            <>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setShareOpen(true)}
                disabled={actionBusy !== null}
              >
                <Share2 className="h-4 w-4 mr-2" />
                Teilen
              </Button>
              <Button
                variant="outline"
                className="w-full"
                onClick={handleDuplicate}
                disabled={actionBusy !== null}
              >
                <Copy className="h-4 w-4 mr-2" />
                Duplizieren
              </Button>
            </>
          )}
          {invoice.status === "cancelled" && (
            <Button
              variant="outline"
              className="w-full"
              onClick={handleDuplicate}
              disabled={actionBusy !== null}
            >
              <Copy className="h-4 w-4 mr-2" />
              Duplizieren
            </Button>
          )}
        </div>
      </div>

      <InvoiceShareLinkDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        invoiceId={invoiceId}
        existingToken={invoice.shareToken}
      />
    </>
  );
}
