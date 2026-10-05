"use client";

import { useRememberedListQuery } from "@/hooks/use-remembered-list-query";
import { Suspense, useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useDropzone } from "react-dropzone";
import { Upload } from "lucide-react";
import { db } from "@/lib/firebase/config";
import { uploadFile, UPLOAD_ACCEPTED_TYPES, UPLOAD_MAX_FILE_SIZE } from "@/lib/files/upload-file";
import {
  connectFileToTransaction,
  assignPartnerToFile,
  retryFileExtraction,
  OperationsContext,
} from "@/lib/operations";
import { useTranslations } from "next-intl";
import { useHandCorrectionGuard } from "@/components/files/hand-correction-dialog";
import { bulkMarkAsInvoiceSummary, markFilesAsInvoice } from "@/lib/files/hand-correction-refusal";
import { FileTable } from "@/components/files/file-table";
import { FileDetailPanel } from "@/components/files/file-detail-panel";
import { FileBulkPanel } from "@/components/files/file-bulk-panel";
import { FileUploadZone } from "@/components/files/file-upload-zone";
import { FileViewerOverlay } from "@/components/files/file-viewer-overlay";
import { ConnectTransactionOverlay } from "@/components/files/connect-transaction-overlay";
import { UploadProgress, FileUploadStatus } from "@/components/files/upload-progress";
import { FilesDataTableHandle } from "@/components/files/files-data-table";
import { SelectionChangeMeta } from "@/components/ui/data-table";
import { useLatestCallback } from "@/hooks/use-latest-callback";
import { useFiles } from "@/hooks/use-files";
import {
  readBankOriginalAmount,
  type BankOriginalAmount,
} from "@/functions/src/fx/bankOriginalAmount";
import { usePartners } from "@/hooks/use-partners";
import { useGlobalPartners } from "@/hooks/use-global-partners";
import { useTransactions } from "@/hooks/use-transactions";
import { TaxFile, FileFilters } from "@/types/file";
import { PartnerFormData } from "@/types/partner";
import { parseFileFiltersFromUrl, buildFileSearchParams } from "@/lib/filters/file-url-params";
import {
  fileDeleteConfirmation,
  bulkFileDeleteConfirmation,
  purgeConfirmation,
} from "@/lib/files/delete-confirmation";
import { isRetentionRelevant } from "@/lib/files/purge-policy";
import { createDropReentryGuard } from "@/lib/files/drop-reentry-guard";
import { useListNavigation } from "@/hooks/use-list-navigation";
import {
  toggleFileCheckbox,
  toggleSelectAll,
  getSelectAllCheckedState,
  resolveSelectionChange,
} from "@/lib/selection/bulk-file-selection";
import { Skeleton } from "@/components/ui/skeleton";
import { SummaryToast, SummaryToastState } from "@/components/ui/summary-toast";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { DetailPanelLayout } from "@/components/ui/detail-panel-layout";
import { useAuth, SmartFeatureGuard } from "@/components/auth";
import { usePageTitle } from "@/hooks/use-page-title";
import { callFunction } from "@/lib/firebase/callable";
import { InvoiceDetailPanel } from "@/components/invoicing/InvoiceDetailPanel";
import { AddPartnerDialog } from "@/components/partners/add-partner-dialog";
import { pushQuery, replaceQuery } from "@/lib/navigation/query-url";
const MAX_FILE_SIZE = UPLOAD_MAX_FILE_SIZE;
const ACCEPTED_TYPES = UPLOAD_ACCEPTED_TYPES;

const PANEL_WIDTH_KEY = "fileDetailPanelWidth";
const DEFAULT_PANEL_WIDTH = 600; // Larger for file preview
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 900;
function FileTableFallback() {
  return (
    <div className="h-full flex flex-col overflow-hidden bg-card">
      {/* Toolbar skeleton */}
      <div className="flex items-center gap-2 px-4 py-2 border-b">
        <Skeleton className="h-9 w-[300px]" />
        <Skeleton className="h-9 w-[100px]" />
      </div>
      {/* Table header skeleton */}
      <div className="flex items-center gap-2 px-4 h-10 border-b bg-muted">
        <Skeleton className="h-4 w-[80px]" />
        <Skeleton className="h-4 w-[70px]" />
        <Skeleton className="h-4 w-[50px]" />
        <Skeleton className="h-4 w-[150px]" />
        <Skeleton className="h-4 w-[80px]" />
      </div>
      {/* Table rows skeleton */}
      <div className="flex-1">
        {[...Array(12)].map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-2 px-4 border-b last:border-b-0"
            style={{ height: 64 }}
          >
            <Skeleton className="h-5 w-[80px]" />
            <Skeleton className="h-5 w-[70px]" />
            <Skeleton className="h-5 w-[50px]" />
            <Skeleton className="h-5 w-[200px]" />
            <Skeleton className="h-5 w-[60px] rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Nothing ticked: a browsed File is highlighted, not checked (#517). */
const NO_FILE_IDS: string[] = [];

function FilesContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Filters survive a trip to another page (#530).
  useRememberedListQuery("files", "/files");
  const { userId } = useAuth();

  // Operations context for file creation
  const ctx: OperationsContext = useMemo(
    () => ({ db, userId: userId ?? "" }),
    [userId]
  );
  const tBulkMarkAsInvoice = useTranslations("files.bulkMarkAsInvoice");
  // Un-marking a File with a Hand Correction is refused by the server; the
  // guard asks before the forced re-extraction overwrites it (#639).
  const handCorrection = useHandCorrectionGuard();
  const guardHandCorrection = handCorrection.guard;

  // Parse filters from URL using centralized utility
  const filters: FileFilters = useMemo(() => {
    return parseFileFiltersFromUrl(searchParams);
  }, [searchParams]);

  // Get search value from URL
  const searchValue = searchParams.get("search") || "";

  const {
    files,
    allFilesCount,
    invoiceCount,
    loading,
    remove,
    restore,
    purge,
    markAsNotInvoice,
    unmarkAsNotInvoice,
    markAsCopy,
    markNotACopy,
    makeOriginal,
    copies,
    copiesOf,
    getFileById,
  } = useFiles({
    search: searchValue,
    ...filters,
  });

  // Partner hooks for partner assignment
  const { partners: userPartners, createPartner } = usePartners();
  const { globalPartners } = useGlobalPartners();

  // Transactions for amount matching display
  const { transactions } = useTransactions();

  // Create a map of fileId -> transaction amounts for AmountMatchDisplay
  const transactionAmountsMap = useMemo(() => {
    const map = new Map<string, Array<{ amount: number; currency: string; original: BankOriginalAmount | null }>>();
    for (const tx of transactions) {
      if (tx.fileIds && tx.fileIds.length > 0) {
        // #112: the bank's own pre-settlement figure, when the row states one.
        const original = readBankOriginalAmount(tx._original?.rawRow);
        for (const fileId of tx.fileIds) {
          const existing = map.get(fileId) || [];
          existing.push({ amount: tx.amount, currency: tx.currency, original });
          map.set(fileId, existing);
        }
      }
    }
    return map;
  }, [transactions]);

  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [creatingInvoice, setCreatingInvoice] = useState(false);
  const tableRef = useRef<FilesDataTableHandle>(null);

  // Multi-file upload state
  const [uploads, setUploads] = useState<FileUploadStatus[]>([]);
  const [showUploadProgress, setShowUploadProgress] = useState(false);

  // Multi-select state:
  // - Primary selection: URL ?id=X (the anchor, shows detail panel)
  // - Additional selections: React state (CMD/Shift added, lighter highlight)
  const [additionalSelectedIds, setAdditionalSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [isBulkPurging, setIsBulkPurging] = useState(false);
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);
  const [isBulkAssigningPartner, setIsBulkAssigningPartner] = useState(false);
  const [isBulkPartnerPickerOpen, setIsBulkPartnerPickerOpen] = useState(false);
  const [bulkProgress, setBulkProgress] = useState<{ completed: number; total: number } | null>(null);
  const [bulkToast, setBulkToast] = useState<SummaryToastState | null>(null);

  // Primary selected ID comes from URL
  const primarySelectedId = searchParams.get("id");

  // Invoice editing param (overrides file detail panel when set)
  const invoiceIdParam = searchParams.get("invoiceId");

  // Combined selection = primary + additional (for bulk operations)
  const allSelectedIds = useMemo(() => {
    const all = new Set(additionalSelectedIds);
    if (primarySelectedId) {
      all.add(primarySelectedId);
    }
    return all;
  }, [primarySelectedId, additionalSelectedIds]);

  // The floating bulk-action bar shows once there's an additional (bulk) selection —
  // solo browsing (just primarySelectedId, no checkboxes/modifier-clicks) doesn't count.
  const showBulkActionBar = additionalSelectedIds.size > 0;

  const displayedFileIds = useMemo(() => files.map((f) => f.id), [files]);

  // The order the table paints: the page's filters and search fold into `files`,
  // the sort column and direction are the table's own state, so it reports them
  // back here. Prev/next walks this list. Until the table has reported (first
  // paint, or while it is behind the loading skeleton) fall back to the hook's
  // array order so navigation is never dead.
  const [tableOrderedFileIds, setTableOrderedFileIds] = useState<string[]>([]);
  const orderedFileIds = useMemo(
    () => (tableOrderedFileIds.length ? tableOrderedFileIds : displayedFileIds),
    [tableOrderedFileIds, displayedFileIds]
  );

  // Ticked boxes: the bulk selection only. A File opened by a plain click is
  // browsed, not checked, so its box stays empty until a bulk selection
  // exists (#517).
  const checkedFileIds = useMemo(
    () => (showBulkActionBar ? allSelectedIds : new Set(NO_FILE_IDS)),
    [showBulkActionBar, allSelectedIds]
  );

  const selectAllState = useMemo(
    () => getSelectAllCheckedState({ displayedFileIds, selectedIds: checkedFileIds }),
    [displayedFileIds, checkedFileIds]
  );

  // Auto-dismiss the bulk-action summary toast
  useEffect(() => {
    if (!bulkToast) return;
    const timer = setTimeout(() => setBulkToast(null), 4000);
    return () => clearTimeout(timer);
  }, [bulkToast]);

  // Clear the bulk selection whenever filters or search actually change (not on
  // every searchParams navigation — filters/searchValue are keyed so this only
  // fires when their real values change, e.g. not when ?id= changes on click).
  const filtersKey = useMemo(() => JSON.stringify(filters), [filters]);
  useEffect(() => {
    setAdditionalSelectedIds(new Set());
  }, [filtersKey, searchValue]);

  // File viewer state
  const [viewerOpen, setViewerOpen] = useState(false);
  const [highlightText, setHighlightText] = useState<string | null>(null);

  // Invoice preview source (lifted from InvoiceDetailPanel so the standard
  // FileViewerOverlay can render over the file list area for invoices too).
  const [invoicePreviewSource, setInvoicePreviewSource] = useState<{
    downloadUrl: string;
    fileName: string;
    fileType: string;
  } | null>(null);

  // Close the invoice viewer whenever the invoice id changes or unmounts.
  // Tracked via ref so the effect only fires on actual id transitions.
  const lastInvoiceIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastInvoiceIdRef.current !== invoiceIdParam) {
      lastInvoiceIdRef.current = invoiceIdParam;
      setViewerOpen(false);
    }
  }, [invoiceIdParam]);

  // When the URL carries ?preview=1 (set by the FAB after creating a new
  // draft), open the overlay immediately and strip the flag from the URL so
  // subsequent navigation doesn't keep re-opening it.
  useEffect(() => {
    if (searchParams.get("preview") !== "1") return;
    setViewerOpen(true);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("preview");
    const newUrl = params.toString() ? `/files?${params.toString()}` : "/files";
    replaceQuery(router, newUrl);
  }, [searchParams, router]);

  const toggleInvoiceViewer = useCallback(() => {
    setViewerOpen((v) => !v);
  }, []);

  // Connect transaction overlay - controlled via URL param
  const isConnectTransactionOpen = searchParams.get("connect") === "true";

  const closeConnectTransactionOverlay = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("connect");
    pushQuery(router, `/files?${params.toString()}`);
  }, [router, searchParams]);

  // Toggle connect overlay (also closes viewer when opening)
  const toggleConnectTransactionOverlay = useCallback(() => {
    if (isConnectTransactionOpen) {
      closeConnectTransactionOverlay();
    } else {
      // Close viewer when opening connect overlay
      setViewerOpen(false);
      setHighlightText(null);
      const params = new URLSearchParams(searchParams.toString());
      params.set("connect", "true");
      pushQuery(router, `/files?${params.toString()}`);
    }
  }, [isConnectTransactionOpen, closeConnectTransactionOverlay, router, searchParams]);

  // Toggle viewer (closes connect overlay if opening)
  const toggleViewer = useCallback(() => {
    if (viewerOpen) {
      setViewerOpen(false);
      setHighlightText(null);
    } else {
      closeConnectTransactionOverlay();
      setViewerOpen(true);
    }
  }, [viewerOpen, closeConnectTransactionOverlay]);

  // Track file ID being parsed after user override (skips classification)
  const [parsingFileId, setParsingFileId] = useState<string | null>(null);

  // Upload a single file and track progress. The bytes, the duplicate check
  // and the File record go through the one shared uploader (lib/files).
  const uploadSingleFile = useCallback(
    async (file: File, uploadId: string) => {
      try {
        const result = await uploadFile(ctx, file, {
          onProgress: (pct) =>
            setUploads((prev) =>
              prev.map((u) => (u.id === uploadId ? { ...u, progress: pct } : u))
            ),
        });

        // Duplicate - handle gracefully without throwing
        if (result.kind === "duplicate") {
          setUploads((prev) =>
            prev.map((u) =>
              u.id === uploadId
                ? {
                    ...u,
                    status: "error" as const,
                    progress: 100, // Mark as processed
                    duplicateFileId: result.existing.id,
                    duplicateFileName: result.existing.fileName,
                  }
                : u
            )
          );
          return null;
        }

        const fileId = result.fileId;

        // Mark as complete
        setUploads((prev) =>
          prev.map((u) =>
            u.id === uploadId
              ? { ...u, status: "complete" as const, progress: 100, fileId }
              : u
          )
        );

        return fileId;
      } catch (err) {
        console.error("File upload failed:", err);
        setUploads((prev) =>
          prev.map((u) =>
            u.id === uploadId
              ? {
                  ...u,
                  status: "error" as const,
                  error: err instanceof Error ? err.message : "Upload failed",
                }
              : u
          )
        );
        return null;
      }
    },
    [ctx]
  );

  // The page's one upload pipeline serves both drop targets — the full-page
  // dropzone and the dialog's zone inside it — so a drop that reaches both
  // arrives here twice. The guard is a ref because React state settles a
  // render too late to refuse the second dispatch (#182).
  const dropGuard = useRef(createDropReentryGuard()).current;

  // Handle multiple file drops
  const handleFileDrop = useCallback(
    async (acceptedFiles: File[]) => {
      if (acceptedFiles.length === 0) return;

      const claim = dropGuard.claim(acceptedFiles);
      if (!claim) return;

      try {
        setIsUploadDialogOpen(false);

        // Create upload status entries
        const newUploads: FileUploadStatus[] = acceptedFiles.map((file, index) => ({
          id: `${Date.now()}-${index}`,
          fileName: file.name,
          progress: 0,
          status: "uploading" as const,
        }));

        setUploads(newUploads);
        setShowUploadProgress(true);

        // Upload all files in parallel
        const uploadPromises = acceptedFiles.map((file, index) =>
          uploadSingleFile(file, newUploads[index].id)
        );

        const results = await Promise.all(uploadPromises);

        // Select first successfully uploaded file
        const firstSuccessfulId = results.find((id) => id !== null);
        if (firstSuccessfulId) {
          const params = buildFileSearchParams(filters, searchValue, firstSuccessfulId);
          pushQuery(router, `/files?${params.toString()}`);
        }
      } finally {
        dropGuard.release(claim);
      }
    },
    [uploadSingleFile, router, filters, searchValue, dropGuard]
  );

  // Dismiss upload progress
  const handleDismissProgress = useCallback(() => {
    setShowUploadProgress(false);
    setUploads([]);
  }, []);

  // Full-page dropzone
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: handleFileDrop,
    accept: ACCEPTED_TYPES,
    maxSize: MAX_FILE_SIZE,
    multiple: true,
    noClick: true, // Don't open file dialog on click - use FAB for that
    noKeyboard: true,
  });

  // One ticked File is still one File (#526): the sidebar shows its details,
  // and the bulk panel takes over from two. Prev/next and close leave the
  // ticked state, since they browse rather than select.
  const singleCheckedId =
    showBulkActionBar && allSelectedIds.size === 1 ? [...allSelectedIds][0] : null;
  const showBulkPanel = showBulkActionBar && allSelectedIds.size >= 2;
  const panelFileId = singleCheckedId ?? primarySelectedId;

  // The File the detail panel is about: the browsed one (?id=) or the one
  // ticked File.
  const selectedFile = useMemo(() => {
    if (!panelFileId || !files.length) return null;
    return files.find((f) => f.id === panelFileId) || null;
  }, [panelFileId, files]);

  // A bulk selection of two or more takes over the sidebar: the bulk panel
  // replaces the one-File detail panel (and the viewer and connect overlay
  // that hang off it). The primary stays selected; clearing the bulk
  // selection brings its panel back.
  const detailFile = showBulkPanel ? null : selectedFile;

  // The detail File's Copy state (#162), read off the user's whole File list:
  // its live original, the live File a suggestion names, its own Copies.
  const detailCopy = useMemo(() => {
    if (!detailFile) return { original: null, suggestedOriginal: null, copies: [] as TaxFile[] };
    const originalId = copies.get(detailFile.id);
    const suggestedId = detailFile.copySuggestion?.originalFileId;
    const suggested = suggestedId ? getFileById(suggestedId) : undefined;
    return {
      original: originalId ? getFileById(originalId) ?? null : null,
      suggestedOriginal: suggested && !suggested.deletedAt && !suggested.purgedAt ? suggested : null,
      copies: copiesOf(detailFile.id),
    };
  }, [detailFile, copies, getFileById, copiesOf]);
  // #571: the invoice this File is the Receipt of, while the pair counts:
  // both live and on one Transaction.
  const detailReceiptInvoice = useMemo(() => {
    const invoiceId = detailFile?.receiptLink?.fileId;
    const invoice = invoiceId ? getFileById(invoiceId) : undefined;
    if (!detailFile || !invoice || invoice.deletedAt || invoice.purgedAt) return null;
    const shared = (detailFile.transactionIds ?? []).some((id) => invoice.transactionIds?.includes(id));
    return shared ? invoice : null;
  }, [detailFile, getFileById]);
  const bulkSelectedFiles = useMemo(
    () => (showBulkPanel ? files.filter((f) => allSelectedIds.has(f.id)) : []),
    [showBulkPanel, files, allSelectedIds]
  );

  // Locate the file that backs the current invoice (if any) so we can pass
  // its id down to InvoiceDetailPanel for issued-invoice preview rendering.
  const invoiceFileId = useMemo(() => {
    if (!invoiceIdParam) return null;
    const match = files.find((f) => f.invoiceId === invoiceIdParam);
    return match?.id ?? null;
  }, [invoiceIdParam, files]);

  // Set page title
  usePageTitle("Files", selectedFile?.fileName);

  // Handle connecting transactions to the selected file
  const handleConnectTransactions = useCallback(
    async (transactionIds: string[]) => {
      if (!selectedFile) return;
      await Promise.all(
        transactionIds.map((transactionId) =>
          connectFileToTransaction(ctx, selectedFile.id, transactionId, "manual")
        )
      );
      closeConnectTransactionOverlay();
    },
    [ctx, selectedFile, closeConnectTransactionOverlay]
  );

  // Note: We intentionally do NOT close the viewer when navigating between files
  // The viewer should stay open so users can browse through files quickly

  // Track previous extractionComplete to detect transitions
  const prevExtractionCompleteRef = useRef<boolean | undefined>(undefined);

  // Clear parsingFileId only when extraction TRANSITIONS from false to true
  // This prevents clearing it immediately when user clicks "Invoice" (before cloud function resets it)
  useEffect(() => {
    const prevComplete = prevExtractionCompleteRef.current;
    const currComplete = selectedFile?.extractionComplete;

    if (parsingFileId && selectedFile?.id === parsingFileId) {
      // Only clear when we see the transition from incomplete to complete
      if (prevComplete === false && currComplete === true) {
        setParsingFileId(null);
      }
    }

    prevExtractionCompleteRef.current = currComplete;
  }, [parsingFileId, selectedFile?.id, selectedFile?.extractionComplete]);

  // URL update helpers using centralized utilities
  const handleSearchChange = useCallback(
    (value: string) => {
      const params = buildFileSearchParams(filters, value, primarySelectedId);
      const newUrl = params.toString() ? `/files?${params.toString()}` : "/files";
      replaceQuery(router, newUrl);
    },
    [router, filters, primarySelectedId]
  );

  const handleFiltersChange = useCallback(
    (newFilters: FileFilters) => {
      const params = buildFileSearchParams(newFilters, searchValue, primarySelectedId);
      const newUrl = params.toString() ? `/files?${params.toString()}` : "/files";
      replaceQuery(router, newUrl);
    },
    [router, searchValue, primarySelectedId]
  );

  const handleSelectFile = useCallback(
    (file: TaxFile) => {
      // Opening a File browses it; a single tick on another File goes (#526).
      setAdditionalSelectedIds((prev) => (prev.size === 1 ? new Set() : prev));
      // Invoice files route via ?invoiceId= so the page-level InvoiceDetailPanel
      // branch mounts (with viewer-toggle and preview-source lifting wired up).
      // The FileDetailPanel fork to InvoiceDetailPanel does NOT lift those, so
      // routing invoice files via ?id= leaves the thumbnail-toggle dead.
      if (file.invoiceId) {
        // Keep filters and search on the URL: they define the list prev/next
        // walks, so landing on an invoice row must not widen it.
        const params = buildFileSearchParams(filters, searchValue, null);
        params.set("invoiceId", file.invoiceId);
        pushQuery(router, `/files?${params.toString()}`);
        return;
      }
      const params = buildFileSearchParams(filters, searchValue, file.id);
      pushQuery(router, `/files?${params.toString()}`);
    },
    [router, filters, searchValue]
  );

  const handleCloseDetail = useCallback(() => {
    // Closing the panel on the one ticked File unticks it too (#526).
    setAdditionalSelectedIds((prev) => (prev.size === 1 ? new Set() : prev));
    const params = buildFileSearchParams(filters, searchValue, null);
    const newUrl = params.toString() ? `/files?${params.toString()}` : "/files";
    pushQuery(router, newUrl);
  }, [router, filters, searchValue]);

  // Checkbox column: independent of row-click selection, so it never opens or
  // navigates the detail panel — except unchecking the primary row's own
  // checkbox, which has no other representation than closing its panel.
  //
  // The table's rows are virtualised and memoised, and the comparator ignores
  // the callbacks a cell paints (see components/ui/data-table/virtual-row.tsx),
  // so a row whose own selection state didn't change keeps the checkbox handler
  // it last painted with. Toggling against that render's copy of
  // additionalSelectedIds is what made the checkboxes act like a radio group:
  // the second row ticked still saw an empty selection and replaced the first
  // (#232). useLatestCallback keeps the identity the stale row holds but runs
  // this render's closure, so the set read below is the live one.
  const handleFileCheckboxChange = useLatestCallback(
    (fileId: string, checked: boolean) => {
      const result = toggleFileCheckbox({
        fileId,
        checked,
        primarySelectedId,
        additionalSelectedIds,
      });
      setAdditionalSelectedIds(result.additionalSelectedIds);
      if (result.closePrimary) {
        handleCloseDetail();
      }
    }
  );

  const handleToggleSelectAll = useCallback(() => {
    // While only browsing, the header box is empty, so it selects every
    // displayed File as a fresh bulk selection rather than reading the
    // browsed File as already ticked (#517).
    const result = toggleSelectAll({
      displayedFileIds,
      primarySelectedId: showBulkActionBar ? primarySelectedId : null,
      additionalSelectedIds,
    });
    if (!showBulkActionBar && primarySelectedId) {
      setAdditionalSelectedIds(result.additionalSelectedIds);
      if (result.additionalSelectedIds.size > 0) handleCloseDetail();
      return;
    }
    setAdditionalSelectedIds(result.additionalSelectedIds);
    if (result.closePrimary) {
      handleCloseDetail();
    }
  }, [displayedFileIds, primarySelectedId, additionalSelectedIds, showBulkActionBar, handleCloseDetail]);

  // Left/right walk the displayed order through the panel that is open: the
  // invoice panel when ?invoiceId= is set, the file panel otherwise. They stay
  // live while the full-screen viewer is open, which follows the selection just
  // as it does for the prev/next buttons (#234). The connect overlay switches
  // them off; portalled dialogs and menus (upload, the bulk partner picker, any
  // dropdown) the hook sees for itself.
  const navigateToFile = useCallback(
    (id: string) => {
      const target = files.find((f) => f.id === id);
      if (target) handleSelectFile(target);
    },
    [files, handleSelectFile]
  );
  const {
    hasPrevious,
    hasNext,
    goPrevious: handleNavigatePrevious,
    goNext: handleNavigateNext,
    advanceAfter: advanceFileAfter,
  } = useListNavigation({
    orderedIds: orderedFileIds,
    currentId: panelFileId,
    onNavigate: navigateToFile,
    panelOpen: !invoiceIdParam && Boolean(detailFile),
    connectOverlayOpen: isConnectTransactionOpen,
  });

  // Navigate from the invoice panel through the files list. When the
  // destination row backs another invoice, route via ?invoiceId= so the
  // page mounts the invoice panel again (with preview lifting); for
  // regular files, route via ?id= so they get the standard file panel.
  const navigateInvoiceTo = useCallback(
    (target: TaxFile) => {
      // Filters and search stay on the URL for the same reason as above.
      const params = buildFileSearchParams(
        filters,
        searchValue,
        target.invoiceId ? null : target.id
      );
      if (target.invoiceId) {
        params.set("invoiceId", target.invoiceId);
      }
      pushQuery(router, `/files?${params.toString()}`);
    },
    [router, filters, searchValue]
  );

  // Invoices are also rows in the files list (each issued invoice has a
  // backing TaxFile), so invoice navigation walks the same displayed order as
  // the file panel.
  const navigateToInvoiceRow = useCallback(
    (id: string) => {
      const target = files.find((f) => f.id === id);
      if (target) navigateInvoiceTo(target);
    },
    [files, navigateInvoiceTo]
  );
  const {
    hasPrevious: invoiceHasPrevious,
    hasNext: invoiceHasNext,
    goPrevious: handleInvoiceNavigatePrevious,
    goNext: handleInvoiceNavigateNext,
  } = useListNavigation({
    orderedIds: orderedFileIds,
    currentId: invoiceFileId,
    onNavigate: navigateToInvoiceRow,
    panelOpen: Boolean(invoiceIdParam),
    connectOverlayOpen: isConnectTransactionOpen,
  });

  const handleDelete = useCallback(async () => {
    if (!selectedFile) return;
    if (!confirm(fileDeleteConfirmation(selectedFile.fileName))) return;
    try {
      await remove(selectedFile.id);
    } catch (error) {
      // The refusal a generated invoice document gets names the invoice and
      // points at cancellation (ADR-0006, #297) — show it, do not swallow it.
      const message = error instanceof Error ? error.message : "Delete failed";
      setBulkToast({ message, tone: "error" });
      return;
    }
    handleCloseDetail();
  }, [selectedFile, remove, handleCloseDetail]);

  const handleRestore = useCallback(async () => {
    if (!selectedFile) return;
    try {
      await restore(selectedFile.id);
    } catch (err) {
      // A Split original is refused while its parts exist (#550); the
      // refusal names them.
      setBulkToast({ message: (err as Error)?.message ?? String(err), tone: "error" });
    }
  }, [selectedFile, restore]);

  // Marking not-invoice from the panel is queue triage: advance to the next
  // row in the displayed order (#251). The next row, and the TaxFile behind
  // it, are taken from the list as it stands BEFORE the write, because the
  // write can drop the current row from the list (Document Type becomes
  // `other`). Bulk marking and unmarking deliberately do not advance.
  const handleMarkAsNotInvoice = useCallback(async () => {
    if (!selectedFile) return;
    await advanceFileAfter(() => markAsNotInvoice(selectedFile.id));
  }, [selectedFile, advanceFileAfter, markAsNotInvoice]);

  const handleUnmarkAsNotInvoice = useCallback(async () => {
    if (!selectedFile) return;
    const fileId = selectedFile.id;
    // Set parsing state FIRST before any Firestore updates (prevents race condition)
    setParsingFileId(fileId);
    // Unmarking queues the re-extraction itself, without re-classifying:
    // the user says it IS an invoice. A File with a Hand Correction is
    // refused; "Extract anyway" is the forced Retry, which re-extracts a File
    // marked not an invoice as an invoice (#639).
    try {
      const outcome = await guardHandCorrection(
        () => unmarkAsNotInvoice(fileId),
        async () => {
          setParsingFileId(fileId);
          try {
            await retryFileExtraction(ctx, fileId, true, { overwriteCorrections: true });
          } catch (error) {
            console.error("Failed to re-extract as invoice:", error);
            setParsingFileId(null);
          }
        }
      );
      // Nothing was queued: the spinner waits for the person's answer.
      if (outcome === "asked") setParsingFileId(null);
    } catch (error) {
      console.error("Failed to mark as invoice:", error);
      setParsingFileId(null);
    }
  }, [selectedFile, unmarkAsNotInvoice, guardHandCorrection, ctx]);


  // FAB: create an empty draft invoice and open the sidebar. Partner and
  // issuer are picked/created inline in the sidebar, not asked upfront.
  //
  // createInvoice also creates a stub TaxFile so the draft shows up as a row
  // in the files list. We navigate to ?id={fileId} (the standard file detail
  // URL) so the row is highlighted; FileDetailPanel forks to
  // InvoiceDetailPanel automatically when file.invoiceId is set.
  const handleCreateInvoice = useCallback(async () => {
    if (creatingInvoice) return;
    setCreatingInvoice(true);
    try {
      const res = await callFunction<
        Record<string, never>,
        { invoiceId: string; fileId?: string }
      >("createInvoice", {});
      // Route via ?invoiceId= so the page's InvoiceDetailPanel branch mounts
      // at the page level — that branch wires up the lifted preview-source /
      // viewer-overlay state, which is required for ?preview=1 below to
      // auto-open the PDF overlay. (The alternative ?id={fileId} route
      // mounts InvoiceDetailPanel via the FileDetailPanel fork, which does
      // NOT lift preview state — so the overlay wouldn't be openable.)
      // Note: this matches the path handleDuplicate falls back to for
      // legacy responses without fileId.
      const params = new URLSearchParams();
      params.set("invoiceId", res.invoiceId);
      // Signal to the page that the PDF preview overlay should open as soon
      // as the InvoiceDetailPanel has produced a preview source. The flag is
      // stripped from the URL by the consuming effect.
      params.set("preview", "1");
      pushQuery(router, `/files?${params.toString()}`);
    } catch (err) {
      console.error("Failed to create invoice:", err);
    } finally {
      setCreatingInvoice(false);
    }
  }, [creatingInvoice, router]);

  const handleCloseInvoice = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("invoiceId");
    const newUrl = params.toString() ? `/files?${params.toString()}` : "/files";
    pushQuery(router, newUrl);
  }, [router, searchParams]);

  // Multi-select: handle selection changes from table. The table sends the
  // full resulting set of selected IDs plus whether a plain (unmodified)
  // click produced it; resolveSelectionChange decides what the primary (URL)
  // and additional (bulk) selections should become from that - see its
  // doc comment for why the resulting Set's size alone can't be trusted.
  const handleSelectionChange = useCallback(
    (newSelectedIds: Set<string>, meta: SelectionChangeMeta) => {
      const result = resolveSelectionChange({
        newSelectedIds,
        isPlainClick: meta.isPlainClick,
        primarySelectedId,
        clickedRowId: meta.clickedRowId,
        isRangeClick: meta.isRangeClick,
      });
      setAdditionalSelectedIds(result.additionalSelectedIds);
      if (result.primaryId !== primarySelectedId) {
        const params = buildFileSearchParams(filters, searchValue, result.primaryId);
        const newUrl = params.toString() ? `/files?${params.toString()}` : "/files";
        pushQuery(router, newUrl);
      }
    },
    [router, filters, searchValue, primarySelectedId]
  );

  // Multi-select: clear additional selections only (keep primary)
  const handleClearSelection = useCallback(() => {
    setAdditionalSelectedIds(new Set());
  }, []);

  // Multi-select: bulk delete
  const handleBulkDelete = useCallback(async () => {
    if (allSelectedIds.size === 0) return;
    const fileIds = Array.from(allSelectedIds);
    if (!confirm(bulkFileDeleteConfirmation(fileIds.length))) return;

    setIsBulkDeleting(true);
    setBulkProgress({ completed: 0, total: fileIds.length });
    let successCount = 0;
    let failureCount = 0;
    try {
      for (const fileId of fileIds) {
        try {
          await remove(fileId);
          successCount++;
        } catch (error) {
          console.error(`Failed to delete file ${fileId}:`, error);
          failureCount++;
        }
        setBulkProgress((prev) => (prev ? { ...prev, completed: prev.completed + 1 } : prev));
      }
      // Clear additional selections and primary
      setAdditionalSelectedIds(new Set());
      const params = buildFileSearchParams(filters, searchValue, null);
      const newUrl = params.toString() ? `/files?${params.toString()}` : "/files";
      pushQuery(router, newUrl);
      setBulkToast({
        message:
          failureCount > 0
            ? `Deleted ${successCount} of ${fileIds.length} files (${failureCount} failed)`
            : `Deleted ${successCount} file${successCount === 1 ? "" : "s"}`,
        tone: failureCount > 0 ? "error" : "success",
      });
    } finally {
      setIsBulkDeleting(false);
      setBulkProgress(null);
    }
  }, [allSelectedIds, remove, router, filters, searchValue]);

  // Multi-select: Purge (#268) — the deleted-files view's one bulk action and
  // the only surface in the product that destroys anything. The confirmation
  // names the count; when the selection holds business records it carries the
  // BAO § 132 retention warning, a warning the user may proceed past. The
  // server refuses generated invoice documents and reports which.
  const handleBulkPurge = useCallback(async () => {
    if (allSelectedIds.size === 0) return;
    const selectedFiles = files.filter((f) => allSelectedIds.has(f.id));
    const fileIds = selectedFiles.map((f) => f.id);
    if (fileIds.length === 0) return;

    const retentionRelevantCount = selectedFiles.filter((f) => isRetentionRelevant(f)).length;
    if (!confirm(purgeConfirmation(fileIds.length, retentionRelevantCount))) return;

    setIsBulkPurging(true);
    try {
      const result = await purge(fileIds);
      setAdditionalSelectedIds(new Set());
      const params = buildFileSearchParams(filters, searchValue, null);
      const newUrl = params.toString() ? `/files?${params.toString()}` : "/files";
      pushQuery(router, newUrl);

      const refusedNames = result.refused
        .map((r) => r.fileName ?? r.fileId)
        .join(", ");
      setBulkToast({
        message:
          result.refused.length > 0
            ? `Purged ${result.purged} of ${fileIds.length} files. Refused: ${refusedNames}`
            : `Purged ${result.purged} file${result.purged === 1 ? "" : "s"}`,
        tone: result.refused.length > 0 ? "error" : "success",
      });
    } catch (error) {
      console.error("Purge failed:", error);
      setBulkToast({ message: "Purge failed", tone: "error" });
    } finally {
      setIsBulkPurging(false);
    }
  }, [allSelectedIds, files, purge, router, filters, searchValue]);

  // Multi-select: bulk mark as not invoice
  const handleBulkMarkAsNotInvoice = useCallback(async () => {
    if (allSelectedIds.size === 0) return;
    const fileIds = Array.from(allSelectedIds);

    setIsBulkUpdating(true);
    setBulkProgress({ completed: 0, total: fileIds.length });
    let successCount = 0;
    let failureCount = 0;
    try {
      for (const fileId of fileIds) {
        try {
          await markAsNotInvoice(fileId);
          successCount++;
        } catch (error) {
          console.error(`Failed to mark file ${fileId} as not invoice:`, error);
          failureCount++;
        }
        setBulkProgress((prev) => (prev ? { ...prev, completed: prev.completed + 1 } : prev));
      }
      setAdditionalSelectedIds(new Set());
      setBulkToast({
        message:
          failureCount > 0
            ? `Updated ${successCount} of ${fileIds.length} files (${failureCount} failed)`
            : `Marked ${successCount} file${successCount === 1 ? "" : "s"} as not invoice`,
        tone: failureCount > 0 ? "error" : "success",
      });
    } finally {
      setIsBulkUpdating(false);
      setBulkProgress(null);
    }
  }, [allSelectedIds, markAsNotInvoice]);

  // Multi-select: bulk mark as invoice (unmark as not invoice)
  const handleBulkMarkAsInvoice = useCallback(async () => {
    if (allSelectedIds.size === 0) return;
    const fileIds = Array.from(allSelectedIds);

    setIsBulkUpdating(true);
    setBulkProgress({ completed: 0, total: fileIds.length });
    try {
      // Each un-mark queues its re-extraction too. A File with a Hand
      // Correction is skipped, never overridden in bulk (#639).
      const result = await markFilesAsInvoice(fileIds, unmarkAsNotInvoice, () =>
        setBulkProgress((prev) => (prev ? { ...prev, completed: prev.completed + 1 } : prev))
      );
      setAdditionalSelectedIds(new Set());
      setBulkToast(bulkMarkAsInvoiceSummary(tBulkMarkAsInvoice, result));
    } finally {
      setIsBulkUpdating(false);
      setBulkProgress(null);
    }
  }, [allSelectedIds, unmarkAsNotInvoice, tBulkMarkAsInvoice]);

  // Multi-select: bulk assign partner. Iterates the same single-file operation
  // the detail panel calls, so twenty files end up recorded exactly as twenty
  // manual assignments would be ("manual", confidence 100) — no new callable,
  // no bulk-specific write path. A file that already had a different partner is
  // overwritten, same as a single manual assignment.
  const handleBulkAssignPartner = useCallback(
    async (partnerId: string, partnerType: "user" | "global") => {
      if (allSelectedIds.size === 0) return;
      const fileIds = Array.from(allSelectedIds);

      setIsBulkAssigningPartner(true);
      setBulkProgress({ completed: 0, total: fileIds.length });
      let successCount = 0;
      let failureCount = 0;
      try {
        for (const fileId of fileIds) {
          try {
            await assignPartnerToFile(ctx, fileId, partnerId, partnerType, "manual", 100);
            successCount++;
          } catch (error) {
            // Partial failure keeps the files already assigned — no rollback.
            console.error(`Failed to assign partner to file ${fileId}:`, error);
            failureCount++;
          }
          setBulkProgress((prev) => (prev ? { ...prev, completed: prev.completed + 1 } : prev));
        }
        setAdditionalSelectedIds(new Set());
        setBulkToast({
          message:
            failureCount > 0
              ? `Assigned partner to ${successCount} of ${fileIds.length} files (${failureCount} failed)`
              : `Assigned partner to ${successCount} file${successCount === 1 ? "" : "s"}`,
          tone: failureCount > 0 ? "error" : "success",
        });
      } finally {
        setIsBulkAssigningPartner(false);
        setBulkProgress(null);
      }
    },
    [allSelectedIds, ctx]
  );

  // Creating a partner from inside the picker assigns it to the selection right
  // away, the same way the detail panel does it for a single file.
  const handleBulkCreateAndAssignPartner = useCallback(
    async (data: PartnerFormData) => {
      const partnerId = await createPartner(data, { skipAutoMatch: true });
      await handleBulkAssignPartner(partnerId, "user");
      return partnerId;
    },
    [createPartner, handleBulkAssignPartner]
  );

  if (loading) {
    return <FileTableFallback />;
  }

  // The right panel: a bulk selection takes priority, then the invoice
  // editor when the invoiceId param is set, then the File's details.
  let detailPanel: ReactNode = null;
  if (showBulkPanel) {
    detailPanel = (
      <FileBulkPanel
        mode={filters.deletedOnly === true ? "deleted" : "live"}
        files={bulkSelectedFiles}
        onClearSelection={handleClearSelection}
        onAssignPartner={() => setIsBulkPartnerPickerOpen(true)}
        onMarkAsNotInvoice={handleBulkMarkAsNotInvoice}
        onMarkAsInvoice={handleBulkMarkAsInvoice}
        onDelete={handleBulkDelete}
        onPurge={handleBulkPurge}
        isDeleting={isBulkDeleting}
        isPurging={isBulkPurging}
        isUpdating={isBulkUpdating}
        isAssigningPartner={isBulkAssigningPartner}
        progress={bulkProgress}
      />
    );
  } else if (!showBulkActionBar && invoiceIdParam) {
    detailPanel = (
      <InvoiceDetailPanel
        invoiceId={invoiceIdParam}
        fileId={invoiceFileId}
        onClose={handleCloseInvoice}
        onPreviewSourceChange={setInvoicePreviewSource}
        viewerOpen={viewerOpen}
        onToggleViewer={toggleInvoiceViewer}
        onNavigatePrevious={handleInvoiceNavigatePrevious}
        onNavigateNext={handleInvoiceNavigateNext}
        hasPrevious={invoiceHasPrevious}
        hasNext={invoiceHasNext}
      />
    );
  } else if (detailFile) {
    detailPanel = (
      <FileDetailPanel
        file={detailFile}
        onClose={handleCloseDetail}
        onNavigatePrevious={handleNavigatePrevious}
        onNavigateNext={handleNavigateNext}
        hasPrevious={hasPrevious}
        hasNext={hasNext}
        onDelete={handleDelete}
        onRestore={handleRestore}
        onMarkAsNotInvoice={handleMarkAsNotInvoice}
        onUnmarkAsNotInvoice={handleUnmarkAsNotInvoice}
        isParsing={parsingFileId === detailFile.id}
        userPartners={userPartners}
        globalPartners={globalPartners}
        onCreatePartner={createPartner}
        onOpenViewer={toggleViewer}
        viewerOpen={viewerOpen}
        onHighlightField={(text) => {
          setHighlightText(text);
          if (!viewerOpen) {
            closeConnectTransactionOverlay();
            setViewerOpen(true);
          }
        }}
        onOpenConnectTransaction={toggleConnectTransactionOverlay}
        isConnectTransactionOpen={isConnectTransactionOpen}
        copyOriginal={detailCopy.original}
        copySuggestionOriginal={detailCopy.suggestedOriginal}
        copiesOfFile={detailCopy.copies}
        receiptInvoice={detailReceiptInvoice}
        onMarkAsCopy={(originalFileId) => markAsCopy(detailFile.id, originalFileId)}
        onNotACopy={() => markNotACopy(detailFile.id)}
        onMakeOriginal={() => makeOriginal(detailFile.id)}
      />
    );
  }

  return (
    <TooltipProvider>
      <div {...getRootProps()} className="h-full overflow-hidden relative">
        <input {...getInputProps()} />

      {/* Upload dialog, opened from the toolbar's "New" menu. */}
      <Dialog open={isUploadDialogOpen} onOpenChange={setIsUploadDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Upload File</DialogTitle>
          </DialogHeader>
          <FileUploadZone onFilesAccepted={handleFileDrop} />
        </DialogContent>
      </Dialog>

      <DetailPanelLayout
        storageKey={PANEL_WIDTH_KEY}
        defaultWidth={DEFAULT_PANEL_WIDTH}
        minWidth={MIN_PANEL_WIDTH}
        maxWidth={MAX_PANEL_WIDTH}
        open={!!(showBulkPanel || detailFile || invoiceIdParam)}
        mainClassName="relative h-full flex flex-col"
        panel={detailPanel}
      >
        <div className="flex-1 overflow-hidden relative">
          {/* Drag overlay — inside the margin-constrained area so it doesn't extend behind the detail panel */}
          {isDragActive && (
            <div className="absolute inset-0 z-40 bg-primary/10 border-2 border-dashed border-primary flex items-center justify-center pointer-events-none">
              <div className="bg-background rounded-lg p-6 shadow-lg text-center">
                <Upload className="h-12 w-12 mx-auto text-primary mb-2" />
                <p className="text-lg font-medium">Drop files to upload</p>
                <p className="text-sm text-muted-foreground">PDF, JPG, PNG, or WebP up to 10MB each</p>
              </div>
            </div>
          )}

          <FileTable
            ref={tableRef}
            files={files}
            allFilesCount={allFilesCount}
            invoiceCount={invoiceCount}
            copies={copies}
            loading={loading}
            onSelectFile={handleSelectFile}
            // While the invoice panel is open there is no ?id=, so hand the
            // invoice's backing row over instead: it gets the primary highlight
            // and the auto-scroll that any other navigated-to row gets.
            selectedFileId={primarySelectedId ?? invoiceFileId}
            searchValue={searchValue}
            onSearchChange={handleSearchChange}
            filters={filters}
            onFiltersChange={handleFiltersChange}
            userPartners={userPartners}
            globalPartners={globalPartners}
            transactionAmountsMap={transactionAmountsMap}
            enableMultiSelect={true}
            selectedRowIds={allSelectedIds}
            checkedRowIds={checkedFileIds}
            onSelectionChange={handleSelectionChange}
            onDisplayedOrderChange={setTableOrderedFileIds}
            onToggleFileSelection={handleFileCheckboxChange}
            onToggleSelectAll={handleToggleSelectAll}
            selectAllState={selectAllState}
            onUploadClick={() => setIsUploadDialogOpen(true)}
            onCreateInvoice={handleCreateInvoice}
            creatingInvoice={creatingInvoice}
          />

          {/* File viewer overlay - positioned over table area only.
              Used for both regular files (via selectedFile) and invoices
              (via invoicePreviewSource lifted from InvoiceDetailPanel). */}
          {viewerOpen && (detailFile || (invoiceIdParam && invoicePreviewSource)) && (
            <FileViewerOverlay
              open={viewerOpen}
              onClose={() => {
                setViewerOpen(false);
                setHighlightText(null);
              }}
              downloadUrl={
                invoiceIdParam && invoicePreviewSource
                  ? invoicePreviewSource.downloadUrl
                  : detailFile!.downloadUrl
              }
              fileType={
                invoiceIdParam && invoicePreviewSource
                  ? invoicePreviewSource.fileType
                  : detailFile!.fileType
              }
              fileName={
                invoiceIdParam && invoicePreviewSource
                  ? invoicePreviewSource.fileName
                  : detailFile!.fileName
              }
              highlightText={highlightText}
            />
          )}

          {/* Connect transaction overlay - positioned over table area */}
          {detailFile && (
            <ConnectTransactionOverlay
              open={isConnectTransactionOpen}
              onClose={closeConnectTransactionOverlay}
              onSelect={handleConnectTransactions}
              connectedTransactionIds={detailFile.transactionIds}
              file={detailFile}
              suggestions={detailFile.transactionSuggestions}
            />
          )}
        </div>

        {/* Upload progress bar - sticky at bottom */}
        {showUploadProgress && uploads.length > 0 && (
          <UploadProgress uploads={uploads} onDismiss={handleDismissProgress} />
        )}
      </DetailPanelLayout>
      </div>
      {/* Bulk "Assign partner": the same picker the detail panel opens, minus
          the per-file suggestions (a selection has no single extracted partner). */}
      <AddPartnerDialog
        open={isBulkPartnerPickerOpen}
        onClose={() => setIsBulkPartnerPickerOpen(false)}
        onAdd={handleBulkCreateAndAssignPartner}
        onSelectPartner={handleBulkAssignPartner}
        userPartners={userPartners}
        globalPartners={globalPartners}
      />
      <SummaryToast toast={bulkToast} />
      {handCorrection.dialog}
    </TooltipProvider>
  );
}

export default function FilesPage() {
  return (
    <SmartFeatureGuard feature="fileUpload">
      <Suspense fallback={<FileTableFallback />}>
        <FilesContent />
      </Suspense>
    </SmartFeatureGuard>
  );
}
