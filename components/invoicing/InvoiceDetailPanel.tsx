"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { format } from "date-fns";
import {
  AlertCircle,
  Copy,
  Download,
  FileText,
  Loader2,
  Pencil,
  Send,
  Share2,
  Trash2,
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
import { ShowMoreButton } from "@/components/ui/show-more-button";
import {
  PanelHeader,
  FieldRow,
} from "@/components/ui/detail-panel-primitives";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { callFunction } from "@/lib/firebase/callable";
import { db } from "@/lib/firebase/config";
import { useInvoice } from "@/hooks/use-invoice";
import { useUserData } from "@/hooks/use-user-data";
import { usePartners } from "@/hooks/use-partners";
import { useGlobalPartners } from "@/hooks/use-global-partners";
import {
  DEFAULT_PAYMENT_TERMS,
  Invoice,
  InvoiceLineItem,
  composeInvoiceName,
  computeInvoiceTotals,
  parsePaymentTermsToDays,
} from "@/types/invoice";
import { TaxFile, TransactionSuggestion } from "@/types/file";
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
import { FileConnectionsList } from "@/components/files/file-connections-list";
import { PartnerPill } from "@/components/partners/partner-pill";
import { buildEpcPayload } from "@/lib/invoicing/epcPayload";
import { toDateSafe } from "@/lib/utils";
import {
  OperationsContext,
  acceptTransactionSuggestion,
  connectFileToTransaction,
  disconnectFileFromTransaction,
  dismissTransactionSuggestion,
  refreshTransactionMatches,
} from "@/lib/operations";
import { useAuth } from "@/components/auth";

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
  /** Up-arrow navigation (previous row in the file list). */
  onNavigatePrevious?: () => void;
  /** Down-arrow navigation (next row in the file list). */
  onNavigateNext?: () => void;
  hasPrevious?: boolean;
  hasNext?: boolean;
  /** Connect-transaction overlay open state (passed to FileConnectionsList). */
  onOpenConnectTransaction?: () => void;
  isConnectTransactionOpen?: boolean;
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

function formatFileSize(bytes: number): string {
  if (!bytes || bytes <= 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface LocalForm {
  issuer: SelectedIssuer | null;
  recipient: SelectedRecipient | null;
  issueDate: string; // yyyy-MM-dd
  paymentTerms: string;
  dueDate: string; // yyyy-MM-dd
  lineItems: InvoiceLineItem[];
  notes: string;
  namePrefix: string;
  /** Stored as string so the user can clear/edit freely; parsed at save time. */
  numberSeq: string;
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
    namePrefix: invoice.namePrefix ?? "",
    numberSeq:
      typeof invoice.numberSeq === "number"
        ? String(invoice.numberSeq)
        : "",
  };
}

function getInvoiceErrorMessage(err: unknown): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string") return err;
  return "Unbekannter Fehler. Bitte versuche es erneut.";
}

export function InvoiceDetailPanel({
  invoiceId,
  fileId,
  onClose,
  onPreviewSourceChange,
  viewerOpen = false,
  onToggleViewer,
  onNavigatePrevious,
  onNavigateNext,
  hasPrevious = false,
  hasNext = false,
  onOpenConnectTransaction,
  isConnectTransactionOpen = false,
}: InvoiceDetailPanelProps) {
  const { invoice, loading } = useInvoice(invoiceId);
  const { userData } = useUserData();
  const { userId } = useAuth();
  const { partners: userPartners } = usePartners();
  const { globalPartners } = useGlobalPartners();
  const [form, setForm] = useState<LocalForm | null>(null);
  const [actionBusy, setActionBusy] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [showMore, setShowMore] = useState(false);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initRef = useRef(false);

  // Lightweight inline toast (see history in previous version of this file).
  const showError = useCallback((message: string) => {
    setErrorBanner(message);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setErrorBanner(null), 6000);
  }, []);
  useEffect(() => {
    return () => {
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, []);

  // Reactively re-snapshot the issuer when the user edits identity in another
  // tab. Same logic as before.
  const issuerEntityId = invoice?.issuer?.entityId;
  const issuerIban = invoice?.issuer?.iban;
  const issuerSignature = useMemo(() => {
    if (!userData || !issuerEntityId) return null;
    const all = [
      userData.personalEntity,
      ...(userData.companies ?? []),
    ].filter((e): e is NonNullable<typeof e> => !!e);
    const entity = all.find((e) => e.id === issuerEntityId);
    if (!entity) return null;
    return JSON.stringify({
      name: entity.name ?? "",
      vatId: entity.vatId ?? "",
      address: entity.address ?? null,
    });
  }, [userData, issuerEntityId]);

  const lastIssuerSignatureRef = useRef<string | null>(null);
  useEffect(() => {
    if (!invoice || invoice.status !== "draft") return;
    if (!issuerEntityId || !issuerIban) return;
    if (issuerSignature === null) return;
    if (lastIssuerSignatureRef.current === null) {
      lastIssuerSignatureRef.current = issuerSignature;
      return;
    }
    if (lastIssuerSignatureRef.current === issuerSignature) return;
    lastIssuerSignatureRef.current = issuerSignature;
    callFunction<
      { invoiceId: string; patch: Record<string, unknown> },
      { invoiceId: string; status: string }
    >("updateInvoice", {
      invoiceId,
      patch: { issuerEntityId, issuerIban },
    }).catch((err) => {
      console.error("Issuer re-snapshot failed:", err);
      showError(
        `Absender konnte nicht aktualisiert werden: ${getInvoiceErrorMessage(err)}`,
      );
    });
  }, [invoice, issuerEntityId, issuerIban, issuerSignature, invoiceId, showError]);

  useEffect(() => {
    lastIssuerSignatureRef.current = null;
  }, [invoiceId]);

  // Hydrate the local form from the invoice once.
  useEffect(() => {
    if (!invoice) return;
    if (initRef.current && form) return;
    initRef.current = true;
    setForm(invoiceToForm(invoice));
  }, [invoice, form]);

  // Reset when switching invoices.
  useEffect(() => {
    initRef.current = false;
    setForm(null);
    setMode("view");
    setShowMore(false);
  }, [invoiceId]);

  const isDraft = invoice?.status === "draft";
  // Editing is allowed in any non-cancelled state. Cancelled invoices are
  // locked because their accounting record must remain immutable.
  const disabled = invoice?.status === "cancelled";

  // Drafts default to edit mode (a brand-new draft is meant to be edited).
  // Issued / sent / paid invoices default to view mode.
  const hasAutoSwitchedForDraftRef = useRef<string | null>(null);
  useEffect(() => {
    if (!invoice) return;
    if (hasAutoSwitchedForDraftRef.current === invoice.id) return;
    if (invoice.status === "draft") {
      setMode("edit");
    }
    hasAutoSwitchedForDraftRef.current = invoice.id;
  }, [invoice]);

  // -------------------------------------------------------------------
  // Issued invoice: subscribe to the linked TaxFile so we can show its real
  // downloadUrl in the preview / overlay AND so we can show transaction
  // connections / suggestions in the view-mode "Transaction" section.
  // -------------------------------------------------------------------
  const [issuedFile, setIssuedFile] = useState<TaxFile | null>(null);
  useEffect(() => {
    setIssuedFile(null);
    if (!fileId) {
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

  // Debounced auto-save (kept; Speichern in edit mode just flushes + exits).
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentRef = useRef<string>("");

  // PDF regen throttle for issued invoices.
  const lastRegenRef = useRef<number>(0);
  const REGEN_THROTTLE_MS = 5000;
  const triggerRegen = useCallback(async () => {
    const now = Date.now();
    if (now - lastRegenRef.current < REGEN_THROTTLE_MS) return;
    lastRegenRef.current = now;
    try {
      await callFunction<
        { invoiceId: string },
        { downloadUrl: string }
      >("regenerateInvoicePdf", { invoiceId });
    } catch (err) {
      console.error("regenerateInvoicePdf (auto) failed:", err);
      showError(
        `PDF konnte nicht neu erzeugt werden: ${getInvoiceErrorMessage(err)}`,
      );
    }
  }, [invoiceId, showError]);

  const sendUpdate = useCallback(
    async (next: LocalForm) => {
      if (!invoice || invoice.status === "cancelled") return;
      const patch: Record<string, unknown> = {
        paymentTerms: next.paymentTerms,
        lineItems: next.lineItems,
        notes: next.notes,
        namePrefix: next.namePrefix.trim() === "" ? null : next.namePrefix.trim(),
      };
      const parsedSeq = parseInt(next.numberSeq, 10);
      if (Number.isInteger(parsedSeq) && parsedSeq >= 1 && parsedSeq <= 9999) {
        patch.numberSeq = parsedSeq;
      }
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
        if (invoice.status !== "draft") {
          triggerRegen();
        }
      } catch (err) {
        console.error("updateInvoice failed:", err);
        showError(
          `Änderungen konnten nicht gespeichert werden: ${getInvoiceErrorMessage(err)}`,
        );
      }
    },
    [invoice, invoiceId, showError, triggerRegen]
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

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  // -------------------------------------------------------------------
  // Phantom draft cleanup (unchanged).
  // -------------------------------------------------------------------
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
      if (!inv || inv.id !== idAtMount) return;
      if (inv.status !== "draft") return;

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

      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }

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

  // Live totals (preview reflects them via onSnapshot once saved).
  const liveTotals = useMemo(() => {
    if (!form) return { subtotal: 0, vatAmount: 0, total: 0 };
    return computeInvoiceTotals(form.lineItems);
  }, [form]);

  // Live composed name.
  const liveDisplayName = useMemo(() => {
    if (!invoice) return "(Entwurf)";
    if (invoice.number && !invoice.number.startsWith("DRAFT-")) {
      return invoice.number;
    }
    const yearStr = form?.issueDate?.slice(0, 4);
    const year = yearStr ? parseInt(yearStr, 10) : undefined;
    const parsedSeq = form ? parseInt(form.numberSeq, 10) : NaN;
    return composeInvoiceName({
      namePrefix: form?.namePrefix,
      recipientName: invoice.recipient?.name,
      year:
        Number.isInteger(year) && year !== undefined && year > 0
          ? year
          : invoice.issueDate?.toDate().getFullYear(),
      numberSeq:
        Number.isInteger(parsedSeq) && parsedSeq >= 1
          ? parsedSeq
          : invoice.numberSeq,
    });
  }, [invoice, form]);

  // Issuability check (unchanged).
  const issuabilityIssues = useMemo<string[]>(() => {
    if (!form) return [];
    const issues: string[] = [];
    if (!form.recipient?.partnerId) issues.push("Empfänger");
    if (!form.issuer?.entityId) issues.push("Absender");
    if (!form.issuer?.iban) issues.push("Absender-IBAN");
    const hasValidLine = form.lineItems.some(
      (li) =>
        li.description.trim() !== "" &&
        (li.unitPrice ?? 0) > 0 &&
        (li.quantity ?? 0) > 0,
    );
    if (!hasValidLine) issues.push("mindestens eine Position mit Preis");
    return issues;
  }, [form]);
  const canIssue = issuabilityIssues.length === 0;

  // -------------------------------------------------------------------
  // Live PDF preview
  //
  // BUG FIX (thumbnail drift / fields-don't-update):
  // Previously, live blob rendering was gated on `isDraft`, so when an issued
  // invoice was edited the thumbnail kept showing the OLD persisted PDF until
  // `regenerateInvoicePdf` finished (throttled 5s + cold start). With the new
  // edit-mode toggle we now render the live blob whenever the user is in edit
  // mode, regardless of status. Once they Speichern/Abbrechen, we fall back
  // to the persisted file URL (which the server has already regenerated).
  //
  // The `previewSignature` memo is unchanged: it stringifies only the PDF-
  // relevant fields. That keeps the render effect from re-firing on
  // unrelated Firestore snapshot identity churn (e.g. issuer re-snapshot).
  // -------------------------------------------------------------------
  const [draftBlobUrl, setDraftBlobUrl] = useState<string | null>(null);
  const [draftRendering, setDraftRendering] = useState(false);
  const previousBlobUrlRef = useRef<string | null>(null);
  const renderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Show live blob whenever the user is actively editing (drafts always edit,
  // issued invoices only while in edit mode).
  const wantsLivePreview = isDraft || mode === "edit";

  const livePreviewInvoice: Invoice | null = useMemo(() => {
    if (!invoice || !form) return null;
    return {
      ...invoice,
      lineItems: form.lineItems,
      notes: form.notes,
      ...computeInvoiceTotals(form.lineItems),
    };
  }, [invoice, form]);

  const livePreviewInvoiceRef = useRef<Invoice | null>(null);
  livePreviewInvoiceRef.current = livePreviewInvoice;

  const previewSignature = useMemo(() => {
    if (!livePreviewInvoice) return null;
    return JSON.stringify({
      n: livePreviewInvoice.number,
      i: livePreviewInvoice.issuer,
      r: livePreviewInvoice.recipient,
      iso: livePreviewInvoice.issueDate?.toDate?.()?.toISOString?.() ?? null,
      dso: livePreviewInvoice.dueDate?.toDate?.()?.toISOString?.() ?? null,
      pt: livePreviewInvoice.paymentTerms,
      li: livePreviewInvoice.lineItems,
      no: livePreviewInvoice.notes,
      cu: livePreviewInvoice.currency,
      t: livePreviewInvoice.total,
    });
  }, [livePreviewInvoice]);

  useEffect(() => {
    if (!wantsLivePreview || !previewSignature) {
      return;
    }

    let cancelled = false;
    if (renderTimerRef.current) clearTimeout(renderTimerRef.current);
    setDraftRendering(true);

    renderTimerRef.current = setTimeout(async () => {
      const current = livePreviewInvoiceRef.current;
      if (!current) {
        setDraftRendering(false);
        return;
      }
      try {
        let qrDataUrl: string | undefined;
        const iban = current.issuer?.iban;
        if (iban) {
          const epc = buildEpcPayload({
            bic: current.issuer?.bic,
            name: current.issuer?.name ?? "",
            iban,
            amountCents: current.total ?? 0,
            remittance: current.number
              ? `Rechnung ${current.number}`
              : undefined,
          });
          try {
            qrDataUrl = await QRCode.toDataURL(epc, { margin: 0, width: 256 });
          } catch (err) {
            console.warn("EPC QR generation failed:", err);
          }
        }

        const { pdf } = await import("@react-pdf/renderer");
        const blob = await pdf(
          <InvoiceDocument
            invoice={current}
            qrDataUrl={qrDataUrl}
          />
        ).toBlob();
        if (cancelled) return;

        const url = URL.createObjectURL(blob);
        const prev = previousBlobUrlRef.current;
        previousBlobUrlRef.current = url;
        setDraftBlobUrl(url);
        setDraftRendering(false);
        if (prev) {
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
  }, [wantsLivePreview, previewSignature]);

  // When we leave edit mode (or switch invoices), drop the live blob so the
  // persisted-file URL takes over cleanly.
  useEffect(() => {
    if (wantsLivePreview) return;
    if (previousBlobUrlRef.current) {
      URL.revokeObjectURL(previousBlobUrlRef.current);
      previousBlobUrlRef.current = null;
    }
    setDraftBlobUrl(null);
  }, [wantsLivePreview]);

  useEffect(() => {
    return () => {
      if (previousBlobUrlRef.current) {
        URL.revokeObjectURL(previousBlobUrlRef.current);
        previousBlobUrlRef.current = null;
      }
    };
  }, []);

  // -------------------------------------------------------------------
  // Active preview source — live blob when editing, persisted file otherwise.
  // -------------------------------------------------------------------
  const previewSource = useMemo(() => {
    if (wantsLivePreview && draftBlobUrl) {
      const fileName =
        liveDisplayName && liveDisplayName !== "(Entwurf)"
          ? `${liveDisplayName}.pdf`
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
  }, [wantsLivePreview, draftBlobUrl, liveDisplayName, issuedFile]);

  useEffect(() => {
    onPreviewSourceChange?.(previewSource);
  }, [onPreviewSourceChange, previewSource]);

  useEffect(() => {
    onPreviewSourceChange?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [invoiceId]);

  useEffect(() => {
    return () => {
      onPreviewSourceChange?.(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -----------------------------------------------------------------
  // Action handlers
  // -----------------------------------------------------------------

  const ACTION_ERROR_LABELS: Record<string, string> = {
    issue: "Rechnung konnte nicht ausgestellt werden",
    cancel: "Rechnung konnte nicht storniert werden",
    duplicate: "Rechnung konnte nicht dupliziert werden",
    regen: "PDF konnte nicht neu erzeugt werden",
    save: "Änderungen konnten nicht gespeichert werden",
  };

  const doAction = useCallback(
    async (name: string, fn: () => Promise<void>) => {
      setActionBusy(name);
      try {
        await fn();
      } catch (err) {
        console.error(`${name} failed:`, err);
        const label = ACTION_ERROR_LABELS[name] || "Aktion fehlgeschlagen";
        showError(`${label}: ${getInvoiceErrorMessage(err)}`);
      } finally {
        setActionBusy(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showError]
  );

  const handleIssue = () =>
    doAction("issue", async () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        if (form) await sendUpdate(form);
      }
      await callFunction<
        { invoiceId: string; createShareLink?: boolean },
        { invoiceId: string; fileId: string; downloadUrl: string }
      >("issueInvoice", { invoiceId });
      setMode("view");
    });

  const handleCancel = () =>
    doAction("cancel", async () => {
      await callFunction<
        { invoiceId: string },
        { invoiceId: string; status: string }
      >("cancelInvoice", { invoiceId });
      onClose();
    });

  const handleDuplicate = () =>
    doAction("duplicate", async () => {
      const res = await callFunction<
        { invoiceId: string },
        { invoiceId: string; fileId?: string }
      >("duplicateInvoice", { invoiceId });
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

  // Speichern in edit mode: flush any pending debounced save, then return to
  // view. Because we keep the autosave debounce alive in edit mode, this
  // effectively just collapses the "is the user still typing?" window.
  const handleSaveAndExit = () =>
    doAction("save", async () => {
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
      }
      if (form) await sendUpdate(form);
      setMode("view");
    });

  // Abbrechen: re-hydrate from server invoice and switch to view.
  // NOTE: autosave fires during typing, so previously-committed edits are NOT
  // reverted. Surfaced in the cancel button's title attribute.
  const handleCancelEdit = useCallback(() => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (invoice) {
      setForm(invoiceToForm(invoice));
    }
    setMode("view");
  }, [invoice]);

  // -----------------------------------------------------------------
  // Transaction connection ops (used by FileConnectionsList in view mode)
  // -----------------------------------------------------------------
  const opsCtx: OperationsContext = useMemo(
    () => ({ db, userId: userId ?? "" }),
    [userId],
  );
  const [isRematching, setIsRematching] = useState(false);

  const handleDisconnectTx = useCallback(
    async (transactionId: string) => {
      if (!issuedFile) return;
      try {
        await disconnectFileFromTransaction(opsCtx, issuedFile.id, transactionId);
      } catch (err) {
        console.error("Failed to disconnect transaction:", err);
      }
    },
    [opsCtx, issuedFile],
  );

  const handleAcceptTxSuggestion = useCallback(
    async (suggestion: TransactionSuggestion) => {
      if (!issuedFile) return;
      await acceptTransactionSuggestion(
        opsCtx,
        issuedFile.id,
        suggestion.transactionId,
        suggestion.confidence,
        suggestion.matchSources,
      );
    },
    [opsCtx, issuedFile],
  );

  const handleDismissTxSuggestion = useCallback(
    async (transactionId: string) => {
      if (!issuedFile) return;
      await dismissTransactionSuggestion(opsCtx, issuedFile.id, transactionId);
    },
    [opsCtx, issuedFile],
  );

  const handleTriggerRematch = useCallback(async () => {
    if (!issuedFile) return;
    setIsRematching(true);
    try {
      await refreshTransactionMatches(opsCtx, issuedFile.id);
    } catch (err) {
      console.error("Failed to refresh transaction matches:", err);
    } finally {
      setIsRematching(false);
    }
  }, [opsCtx, issuedFile]);

  // Resolve the assigned (recipient) partner for the view-mode Partner section.
  const recipientPartner = useMemo(() => {
    const rec = invoice?.recipient;
    if (!rec?.partnerId) return null;
    if (rec.partnerType === "user") {
      return userPartners.find((p) => p.id === rec.partnerId) ?? null;
    }
    return globalPartners.find((p) => p.id === rec.partnerId) ?? null;
  }, [invoice?.recipient, userPartners, globalPartners]);

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

  const issueDateAsDate = toDateSafe(invoice.issueDate);
  const dueDateAsDate = toDateSafe(invoice.dueDate);
  const createdAtAsDate = toDateSafe(invoice.createdAt);
  const hasIssuedPdf = !!(issuedFile && issuedFile.downloadUrl);

  return (
    <>
      <div className="h-full flex flex-col">
        <PanelHeader
          title={`Rechnung ${liveDisplayName}`}
          onClose={onClose}
          onNavigatePrevious={onNavigatePrevious}
          onNavigateNext={onNavigateNext}
          hasPrevious={hasPrevious}
          hasNext={hasNext}
        >
          {invoice.status === "draft" && (
            <InvoiceStatusBadge status={invoice.status} />
          )}
        </PanelHeader>

        {errorBanner && (
          <div className="flex-shrink-0 border-b bg-destructive/10 text-destructive px-4 py-2 text-xs flex items-start gap-2">
            <AlertCircle className="h-3.5 w-3.5 mt-0.5 flex-shrink-0" />
            <span className="flex-1">{errorBanner}</span>
            <button
              type="button"
              onClick={() => setErrorBanner(null)}
              className="flex-shrink-0 opacity-70 hover:opacity-100"
              aria-label="Hinweis schließen"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        )}

        <ScrollArea className="flex-1">
          <div className="p-4 space-y-6">
            {/* Preview thumbnail row — same layout as file-detail-panel. */}
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
                    <p
                      className="text-xs text-muted-foreground text-center mt-1 mx-auto"
                      style={{ minWidth: "13ch" }}
                    >
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
              <div className="flex-1 space-y-2">
                {/* Quick file info — mirrors the file-detail-panel "Source &
                    From at top" block exactly. */}
                <div className="text-sm space-y-1">
                  <div className="flex items-start gap-3 file-meta-row">
                    <span className="text-muted-foreground w-16 shrink-0 file-meta-label">
                      Source
                    </span>
                    <div className="flex-1 text-right file-meta-value">
                      <span className="inline-flex items-center gap-1">
                        <FileText className="h-3 w-3" />
                        Rechnungserstellung
                      </span>
                    </div>
                  </div>
                  <div className="flex items-start gap-3 file-meta-row">
                    <span className="text-muted-foreground w-16 shrink-0 file-meta-label">
                      Uploaded
                    </span>
                    <span className="flex-1 text-right file-meta-value">
                      {issuedFile?.uploadedAt
                        ? format(issuedFile.uploadedAt.toDate(), "MMM d, yyyy")
                        : createdAtAsDate
                          ? format(createdAtAsDate, "MMM d, yyyy")
                          : "—"}
                    </span>
                  </div>
                  <div className="flex items-start gap-3 file-meta-row">
                    <span className="text-muted-foreground w-16 shrink-0 file-meta-label">
                      Size
                    </span>
                    <span className="flex-1 text-right file-meta-value">
                      {issuedFile ? formatFileSize(issuedFile.fileSize) : "—"}
                    </span>
                  </div>
                  <div className="flex items-start gap-3 file-meta-row">
                    <span className="text-muted-foreground w-16 shrink-0 file-meta-label">
                      Type
                    </span>
                    <span className="flex-1 text-right file-meta-value">
                      Invoice
                    </span>
                  </div>
                  <div className="flex items-start gap-3 file-meta-row">
                    <span className="text-muted-foreground w-16 shrink-0 file-meta-label">
                      Amount
                    </span>
                    <span className="flex-1 text-right file-meta-value tabular-nums">
                      {form.lineItems.length === 0 || liveTotals.total === 0
                        ? "—"
                        : formatEur(liveTotals.total)}
                    </span>
                  </div>
                </div>
              </div>
            </div>

            <Separator />

            {mode === "view" ? (
              <ViewSections
                invoice={invoice}
                liveTotals={liveTotals}
                form={form}
                issueDate={issueDateAsDate}
                dueDate={dueDateAsDate}
                liveDisplayName={liveDisplayName}
                showMore={showMore}
                onToggleShowMore={() => setShowMore((p) => !p)}
                recipientPartner={recipientPartner}
                issuedFile={issuedFile}
                onConnectClick={onOpenConnectTransaction}
                isConnectOpen={isConnectTransactionOpen}
                onAcceptTxSuggestion={handleAcceptTxSuggestion}
                onDismissTxSuggestion={handleDismissTxSuggestion}
                onDisconnectTx={handleDisconnectTx}
                onTriggerRematch={handleTriggerRematch}
                isRematching={isRematching}
                onEnterEditMode={() => setMode("edit")}
              />
            ) : (
              <EditSections
                form={form}
                updateForm={updateForm}
                disabled={!!disabled}
                liveTotals={liveTotals}
                liveDisplayName={liveDisplayName}
                cancelledNotice={invoice.status === "cancelled"}
              />
            )}
          </div>
        </ScrollArea>

        {/* "What's missing" hint — only shown for draft invoices that aren't
            yet issuable. Same as before. */}
        {invoice.status === "draft" && issuabilityIssues.length > 0 && (
          <div className="flex-shrink-0 border-t bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
            Fehlend: {issuabilityIssues.join(", ")}
          </div>
        )}

        {/* Footer */}
        <div className="flex-shrink-0 border-t bg-background p-4 space-y-2">
          {mode === "edit" ? (
            <div className="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                onClick={handleCancelEdit}
                disabled={actionBusy !== null}
                title="Schließt den Editor. Bereits gespeicherte Änderungen werden NICHT zurückgenommen — die Autovervollständigung speichert beim Tippen."
              >
                Abbrechen
              </Button>
              <Button
                onClick={handleSaveAndExit}
                disabled={actionBusy !== null}
              >
                {actionBusy === "save" ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : null}
                Speichern
              </Button>
            </div>
          ) : (
            <>
              {/* Edit affordance at the TOP of the footer. */}
              {!disabled && (
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => setMode("edit")}
                  disabled={actionBusy !== null}
                >
                  <Pencil className="h-4 w-4 mr-2" />
                  Rechnung bearbeiten
                </Button>
              )}

              {invoice.status === "draft" && (
                <Button
                  className="w-full"
                  onClick={handleIssue}
                  disabled={actionBusy !== null || !canIssue}
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
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="outline"
                      onClick={() => setShareOpen(true)}
                      disabled={actionBusy !== null}
                    >
                      <Share2 className="h-4 w-4 mr-2" />
                      Teilen
                    </Button>
                    <Button
                      variant="outline"
                      onClick={handleDuplicate}
                      disabled={actionBusy !== null}
                    >
                      <Copy className="h-4 w-4 mr-2" />
                      Duplizieren
                    </Button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    {hasIssuedPdf && (
                      <Button variant="outline" asChild>
                        <a
                          href={issuedFile!.downloadUrl}
                          download={issuedFile!.fileName}
                        >
                          <Download className="h-4 w-4 mr-2" />
                          Download
                        </a>
                      </Button>
                    )}
                    <AlertDialog>
                      <AlertDialogTrigger asChild>
                        <Button
                          variant="outline"
                          className={
                            hasIssuedPdf
                              ? "text-destructive hover:text-destructive hover:bg-destructive/10"
                              : "col-span-2 text-destructive hover:text-destructive hover:bg-destructive/10"
                          }
                          disabled={actionBusy !== null}
                        >
                          <Trash2 className="h-4 w-4 mr-2" />
                          Löschen
                        </Button>
                      </AlertDialogTrigger>
                      <AlertDialogContent>
                        <AlertDialogHeader>
                          <AlertDialogTitle>Rechnung löschen?</AlertDialogTitle>
                          <AlertDialogDescription>
                            Die Rechnung wird gelöscht und das verknüpfte PDF
                            wird ausgeblendet. Dieser Schritt lässt sich nicht
                            rückgängig machen — du kannst die Rechnung aber
                            duplizieren, um einen neuen Entwurf zu erstellen.
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel disabled={actionBusy === "cancel"}>
                            Abbrechen
                          </AlertDialogCancel>
                          <AlertDialogAction
                            onClick={handleCancel}
                            disabled={actionBusy !== null}
                            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                          >
                            {actionBusy === "cancel" && (
                              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            )}
                            Löschen
                          </AlertDialogAction>
                        </AlertDialogFooter>
                      </AlertDialogContent>
                    </AlertDialog>
                  </div>
                </>
              )}

              {invoice.status === "paid" && (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <Button
                      variant="outline"
                      onClick={() => setShareOpen(true)}
                      disabled={actionBusy !== null}
                    >
                      <Share2 className="h-4 w-4 mr-2" />
                      Teilen
                    </Button>
                    <Button
                      variant="outline"
                      onClick={handleDuplicate}
                      disabled={actionBusy !== null}
                    >
                      <Copy className="h-4 w-4 mr-2" />
                      Duplizieren
                    </Button>
                  </div>
                  {hasIssuedPdf && (
                    <Button variant="outline" className="w-full" asChild>
                      <a
                        href={issuedFile!.downloadUrl}
                        download={issuedFile!.fileName}
                      >
                        <Download className="h-4 w-4 mr-2" />
                        Download
                      </a>
                    </Button>
                  )}
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
            </>
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

// ===========================================================================
// View mode — read-only label/value rows, mirroring file-detail-panel.
// ===========================================================================

interface ViewSectionsProps {
  invoice: Invoice;
  liveTotals: { subtotal: number; vatAmount: number; total: number };
  form: LocalForm;
  issueDate: Date | null;
  dueDate: Date | null;
  liveDisplayName: string;
  showMore: boolean;
  onToggleShowMore: () => void;
  recipientPartner: { id: string; name: string } | null;
  issuedFile: TaxFile | null;
  onConnectClick?: () => void;
  isConnectOpen?: boolean;
  onAcceptTxSuggestion: (suggestion: TransactionSuggestion) => Promise<void>;
  onDismissTxSuggestion: (transactionId: string) => Promise<void>;
  onDisconnectTx: (transactionId: string) => Promise<void>;
  onTriggerRematch: () => Promise<void>;
  isRematching: boolean;
  onEnterEditMode: () => void;
}

function ViewSections({
  invoice,
  liveTotals,
  form,
  issueDate,
  dueDate,
  recipientPartner,
  showMore,
  onToggleShowMore,
  issuedFile,
  onConnectClick,
  isConnectOpen,
  onAcceptTxSuggestion,
  onDismissTxSuggestion,
  onDisconnectTx,
  onTriggerRematch,
  isRematching,
  onEnterEditMode,
}: ViewSectionsProps) {
  const lineItemCount = form.lineItems.filter(
    (li) => li.description.trim() !== "" || (li.unitPrice ?? 0) > 0,
  ).length;

  return (
    <>
      {/* Information */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Information</h3>

        <FieldRow label="Document Date" labelWidth="w-28">
          {issueDate ? format(issueDate, "MMM d, yyyy") : "—"}
        </FieldRow>
        <FieldRow label="Due date" labelWidth="w-28">
          {dueDate ? format(dueDate, "MMM d, yyyy") : "—"}
        </FieldRow>
        <FieldRow label="Amount net" labelWidth="w-28">
          <span className="tabular-nums">{formatEur(liveTotals.subtotal)}</span>
        </FieldRow>
        <FieldRow label="VAT amount" labelWidth="w-28">
          <span className="tabular-nums">{formatEur(liveTotals.vatAmount)}</span>
        </FieldRow>
        <FieldRow label="Total gross" labelWidth="w-28">
          <span className="tabular-nums font-medium">
            {formatEur(liveTotals.total)}
          </span>
        </FieldRow>

        <ShowMoreButton
          expanded={showMore}
          onToggle={onToggleShowMore}
          className="pt-1"
        />

        {showMore && (
          <div className="space-y-2 pt-1">
            <FieldRow label="Invoice number" labelWidth="w-28">
              <span className="font-mono">{invoice.number || "—"}</span>
            </FieldRow>
            <FieldRow label="Name prefix" labelWidth="w-28">
              {form.namePrefix?.trim() || "—"}
            </FieldRow>
            <FieldRow label="Payment terms" labelWidth="w-28">
              {invoice.paymentTerms || "—"}
            </FieldRow>
            <FieldRow label="Notes" labelWidth="w-28">
              {form.notes?.trim() ? (
                <span className="whitespace-pre-wrap">{form.notes}</span>
              ) : (
                "—"
              )}
            </FieldRow>
            <FieldRow label="Line items" labelWidth="w-28">
              {lineItemCount}
            </FieldRow>
          </div>
        )}
      </div>

      <Separator />

      {/* Partner */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Partner</h3>
        <FieldRow label="Connect" labelWidth="w-28">
          {recipientPartner ? (
            <PartnerPill
              name={recipientPartner.name}
              partnerType={invoice.recipient?.partnerType}
              onClick={onEnterEditMode}
            />
          ) : (
            <button
              type="button"
              onClick={onEnterEditMode}
              className="text-sm text-primary hover:underline"
            >
              + Empfänger wählen
            </button>
          )}
        </FieldRow>
      </div>

      <Separator />

      {/* Transaction */}
      {issuedFile ? (
        <FileConnectionsList
          file={issuedFile}
          onDisconnect={onDisconnectTx}
          onConnectClick={onConnectClick}
          isConnectOpen={isConnectOpen}
          suggestions={issuedFile.transactionSuggestions}
          onAcceptSuggestion={onAcceptTxSuggestion}
          onDismissSuggestion={onDismissTxSuggestion}
          onTriggerRematch={onTriggerRematch}
          isRematching={isRematching}
        />
      ) : (
        <div className="space-y-2">
          <h3 className="text-sm font-medium">Transaction</h3>
          <FieldRow label="Connect" labelWidth="w-28">
            <span className="text-sm text-muted-foreground">
              Verfügbar, sobald die Rechnung ausgestellt wurde
            </span>
          </FieldRow>
        </div>
      )}
    </>
  );
}

// ===========================================================================
// Edit mode — the editable form (issuer, recipient, dates, line items, notes).
// Functionally the same as the previous panel body.
// ===========================================================================

interface EditSectionsProps {
  form: LocalForm;
  updateForm: (patch: Partial<LocalForm>) => void;
  disabled: boolean;
  liveTotals: { subtotal: number; vatAmount: number; total: number };
  liveDisplayName: string;
  cancelledNotice: boolean;
}

function EditSections({
  form,
  updateForm,
  disabled,
  liveTotals,
  liveDisplayName,
  cancelledNotice,
}: EditSectionsProps) {
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground">
          Rechnungs-Nummerierung
        </Label>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <div className="space-y-1.5">
            <Label
              htmlFor="invoice-name-prefix"
              className="text-[10px] uppercase tracking-wider text-muted-foreground"
            >
              Rechnungsname
            </Label>
            <Input
              id="invoice-name-prefix"
              value={form.namePrefix}
              onChange={(e) => updateForm({ namePrefix: e.target.value })}
              placeholder="z. B. INV"
              maxLength={16}
              disabled={disabled}
            />
          </div>
          <div className="space-y-1.5">
            <Label
              htmlFor="invoice-number-seq"
              className="text-[10px] uppercase tracking-wider text-muted-foreground"
            >
              Nummer
            </Label>
            <Input
              id="invoice-number-seq"
              type="number"
              min={1}
              max={9999}
              inputMode="numeric"
              value={form.numberSeq}
              onChange={(e) =>
                updateForm({
                  numberSeq: e.target.value.replace(/[^0-9]/g, ""),
                })
              }
              className="w-24 tabular-nums"
              placeholder="0001"
              disabled={disabled}
            />
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">
          Vorschau: <span className="font-mono">{liveDisplayName}</span>
        </p>
      </div>

      <Separator />

      <InvoiceIssuerPicker
        value={form.issuer}
        onChange={(issuer) => updateForm({ issuer })}
        disabled={disabled}
      />

      <Separator />

      <InvoiceRecipientField
        value={form.recipient}
        onChange={(recipient) => updateForm({ recipient })}
        disabled={disabled}
      />

      <Separator />

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Rechnungsdatum</Label>
          <Input
            type="date"
            value={form.issueDate}
            onChange={(e) => updateForm({ issueDate: e.target.value })}
            disabled={disabled}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Fällig am</Label>
          <Input
            type="date"
            value={form.dueDate}
            onChange={(e) => updateForm({ dueDate: e.target.value })}
            disabled={disabled}
          />
        </div>
      </div>

      <Separator />

      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground">Positionen</Label>
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
        <Label className="text-xs text-muted-foreground">Notiz</Label>
        <textarea
          value={form.notes}
          onChange={(e) => updateForm({ notes: e.target.value })}
          disabled={disabled}
          rows={3}
          className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
          placeholder="Optionaler Hinweis am Ende der Rechnung…"
        />
      </div>

      {cancelledNotice && (
        <div className="text-xs text-muted-foreground bg-muted/40 border rounded-md p-2 flex items-start gap-2">
          <XCircle className="h-3.5 w-3.5 mt-0.5" />
          <span>
            Diese Rechnung wurde storniert und ist nicht mehr editierbar.
            Dupliziere sie, um einen neuen Entwurf zu erstellen.
          </span>
        </div>
      )}
    </div>
  );
}
