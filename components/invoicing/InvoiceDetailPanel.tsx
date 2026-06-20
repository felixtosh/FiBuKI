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
  Eye,
  Loader2,
  RefreshCw,
  Send,
  Share2,
  Trash2,
  X,
  XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { callFunction } from "@/lib/firebase/callable";
import { useInvoice } from "@/hooks/use-invoice";
import {
  DEFAULT_PAYMENT_TERMS,
  Invoice,
  InvoiceLineItem,
  computeInvoiceTotals,
  parsePaymentTermsToDays,
} from "@/types/invoice";
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
import { InvoiceViewerOverlay } from "./InvoiceViewerOverlay";

interface InvoiceDetailPanelProps {
  invoiceId: string;
  /** Optional file id (set once the invoice has been issued and the file exists). */
  fileId?: string | null;
  onClose: () => void;
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
  onClose,
}: InvoiceDetailPanelProps) {
  const { invoice, loading } = useInvoice(invoiceId);
  const [form, setForm] = useState<LocalForm | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
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
    setPreviewOpen(false);
  }, [invoiceId]);

  const isDraft = invoice?.status === "draft";
  const disabled = !isDraft;

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

  const handleDelete = () =>
    doAction("delete", async () => {
      await callFunction<{ invoiceId: string }, { success: boolean }>(
        "deleteInvoice",
        { invoiceId }
      );
      onClose();
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

  // For the InvoiceViewerOverlay we need a live snapshot of the invoice that
  // reflects unsaved edits. The persisted Invoice has Timestamp fields, so we
  // splice in the local form values without mutating the stored doc.
  const livePreviewInvoice: Invoice = {
    ...invoice,
    lineItems: form.lineItems,
    notes: form.notes,
    ...computeInvoiceTotals(form.lineItems),
  };

  // Issued invoices: load the linked file's downloadUrl via the invoice.fileId.
  // We don't have direct access to the TaxFile here, but the existing
  // InvoiceViewerOverlay falls back to PDFViewer rendering when no downloadUrl
  // is provided. For issued invoices, the parent (file detail panel) typically
  // owns the file context; here we render live for drafts and load the
  // persisted PDF via a known URL pattern when available. The overlay's
  // isDraft check (status !== "draft" && downloadUrl) gates between the two.
  // Issued invoices without an in-context downloadUrl still render live (same
  // data, same template) so the user always gets a preview.

  return (
    <>
      <div className="h-full flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between gap-2 h-[53px] border-b px-4 flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <h2 className="text-sm font-semibold truncate">
              Rechnung {invoice.number || "(Entwurf)"}
            </h2>
            <InvoiceStatusBadge status={invoice.status} />
          </div>
          <div className="flex items-center gap-1">
            {/* Preview button - always available */}
            <Button
              size="sm"
              variant="outline"
              onClick={() => setPreviewOpen(true)}
              title="Vorschau"
            >
              <Eye className="h-3.5 w-3.5 mr-1.5" />
              Vorschau
            </Button>

            {/* Action buttons (status-aware) */}
            {invoice.status === "draft" && (
              <>
                <Button
                  size="sm"
                  onClick={handleIssue}
                  disabled={actionBusy !== null}
                >
                  {actionBusy === "issue" ? (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  ) : (
                    <Send className="h-3.5 w-3.5 mr-1.5" />
                  )}
                  Ausstellen
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleDuplicate}
                  disabled={actionBusy !== null}
                  title="Duplizieren"
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleDelete}
                  disabled={actionBusy !== null}
                  className="text-destructive hover:text-destructive"
                  title="Löschen"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
            {(invoice.status === "issued" || invoice.status === "sent") && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShareOpen(true)}
                  disabled={actionBusy !== null}
                  title="Teilen"
                >
                  <Share2 className="h-3.5 w-3.5 mr-1.5" />
                  Teilen
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleRegen}
                  disabled={actionBusy !== null}
                  title="PDF neu erzeugen"
                >
                  {actionBusy === "regen" ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <RefreshCw className="h-3.5 w-3.5" />
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleDuplicate}
                  disabled={actionBusy !== null}
                  title="Duplizieren"
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleCancel}
                  disabled={actionBusy !== null}
                  className="text-destructive hover:text-destructive"
                  title="Stornieren"
                >
                  <XCircle className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
            {invoice.status === "paid" && (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShareOpen(true)}
                  disabled={actionBusy !== null}
                  title="Teilen"
                >
                  <Share2 className="h-3.5 w-3.5 mr-1.5" />
                  Teilen
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={handleDuplicate}
                  disabled={actionBusy !== null}
                  title="Duplizieren"
                >
                  <Copy className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
            {invoice.status === "cancelled" && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleDuplicate}
                disabled={actionBusy !== null}
                title="Duplizieren"
              >
                <Copy className="h-3.5 w-3.5 mr-1.5" />
                Duplizieren
              </Button>
            )}
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
        </div>

        {/* Body: single-column editor (preview is opened via the Vorschau button) */}
        <ScrollArea className="flex-1">
          <div className="p-4 space-y-4">
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
      </div>

      <InvoiceShareLinkDialog
        open={shareOpen}
        onOpenChange={setShareOpen}
        invoiceId={invoiceId}
        existingToken={invoice.shareToken}
      />

      <InvoiceViewerOverlay
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        invoice={livePreviewInvoice}
      />
    </>
  );
}
