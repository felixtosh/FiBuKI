"use client";

import { Suspense, useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useDropzone } from "react-dropzone";
import { ref, uploadBytesResumable, getDownloadURL } from "firebase/storage";
import { FileText, Upload, Loader2 } from "lucide-react";
import { storage, db } from "@/lib/firebase/config";
import { createFile, checkFileDuplicate, retryFileExtraction, connectFileToTransaction, OperationsContext } from "@/lib/operations";
import { FileTable } from "@/components/files/file-table";
import { FileDetailPanel } from "@/components/files/file-detail-panel";
import { FileBulkActionsPanel } from "@/components/files/file-bulk-actions-panel";
import { FileUploadZone } from "@/components/files/file-upload-zone";
import { FileViewerOverlay } from "@/components/files/file-viewer-overlay";
import { ConnectTransactionOverlay } from "@/components/files/connect-transaction-overlay";
import { UploadProgress, FileUploadStatus } from "@/components/files/upload-progress";
import { FilesDataTableHandle } from "@/components/files/files-data-table";
import { useFiles } from "@/hooks/use-files";
import { usePartners } from "@/hooks/use-partners";
import { useGlobalPartners } from "@/hooks/use-global-partners";
import { useTransactions } from "@/hooks/use-transactions";
import { TaxFile, FileFilters } from "@/types/file";
import { parseFileFiltersFromUrl, buildFileSearchParams } from "@/lib/filters/file-url-params";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { TooltipProvider } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useAuth, SmartFeatureGuard } from "@/components/auth";
import { usePageTitle } from "@/hooks/use-page-title";
import { callFunction } from "@/lib/firebase/callable";
import { InvoiceDetailPanel } from "@/components/invoicing/InvoiceDetailPanel";
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ACCEPTED_TYPES = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "application/pdf": [".pdf"],
};

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

function FilesContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { userId } = useAuth();

  // Operations context for file creation
  const ctx: OperationsContext = useMemo(
    () => ({ db, userId: userId ?? "" }),
    [userId]
  );

  // Parse filters from URL using centralized utility
  const filters: FileFilters = useMemo(() => {
    return parseFileFiltersFromUrl(searchParams);
  }, [searchParams]);

  // Get search value from URL
  const searchValue = searchParams.get("search") || "";

  const { files, allFilesCount, loading, remove, restore, markAsNotInvoice, unmarkAsNotInvoice } = useFiles({
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
    const map = new Map<string, Array<{ amount: number; currency: string }>>();
    for (const tx of transactions) {
      if (tx.fileIds && tx.fileIds.length > 0) {
        for (const fileId of tx.fileIds) {
          const existing = map.get(fileId) || [];
          existing.push({ amount: tx.amount, currency: tx.currency });
          map.set(fileId, existing);
        }
      }
    }
    return map;
  }, [transactions]);

  const [isUploadDialogOpen, setIsUploadDialogOpen] = useState(false);
  const [creatingInvoice, setCreatingInvoice] = useState(false);
  const [panelWidth, setPanelWidth] = useState<number>(DEFAULT_PANEL_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const currentWidthRef = useRef(panelWidth);
  const tableRef = useRef<FilesDataTableHandle>(null);

  // Multi-file upload state
  const [uploads, setUploads] = useState<FileUploadStatus[]>([]);
  const [showUploadProgress, setShowUploadProgress] = useState(false);

  // Multi-select state:
  // - Primary selection: URL ?id=X (the anchor, shows detail panel)
  // - Additional selections: React state (CMD/Shift added, lighter highlight)
  const [additionalSelectedIds, setAdditionalSelectedIds] = useState<Set<string>>(new Set());
  const [isBulkDeleting, setIsBulkDeleting] = useState(false);
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);

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

  // Derive selected files from all IDs
  const selectedFiles = useMemo(() => {
    return files.filter((f) => allSelectedIds.has(f.id));
  }, [files, allSelectedIds]);

  // Show bulk panel when there are additional selections (primary + at least one more)
  const showBulkPanel = additionalSelectedIds.size > 0;

  // File viewer state
  const [viewerOpen, setViewerOpen] = useState(false);
  const [highlightText, setHighlightText] = useState<string | null>(null);

  // Connect transaction overlay - controlled via URL param
  const isConnectTransactionOpen = searchParams.get("connect") === "true";

  const closeConnectTransactionOverlay = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("connect");
    router.push(`/files?${params.toString()}`, { scroll: false });
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
      router.push(`/files?${params.toString()}`, { scroll: false });
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

  // Calculate SHA-256 hash of file content
  const calculateFileHash = useCallback(async (file: File): Promise<string> => {
    const buffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }, []);

  // Upload a single file and track progress
  const uploadSingleFile = useCallback(
    async (file: File, uploadId: string) => {
      try {
        // Calculate hash first for duplicate detection
        const contentHash = await calculateFileHash(file);

        // Check for duplicate - handle gracefully without throwing
        const existingFile = await checkFileDuplicate(ctx, contentHash);
        if (existingFile) {
          setUploads((prev) =>
            prev.map((u) =>
              u.id === uploadId
                ? {
                    ...u,
                    status: "error" as const,
                    progress: 100, // Mark as processed
                    duplicateFileId: existingFile.id,
                    duplicateFileName: existingFile.fileName,
                  }
                : u
            )
          );
          return null;
        }

        // Create storage path
        const timestamp = Date.now();
        const sanitizedName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_");
        const storagePath = `files/${userId}/${timestamp}_${sanitizedName}`;

        // Upload to Firebase Storage
        const storageRef = ref(storage, storagePath);
        const uploadTask = uploadBytesResumable(storageRef, file);

        // Track upload progress
        await new Promise<void>((resolve, reject) => {
          uploadTask.on(
            "state_changed",
            (snapshot) => {
              const pct = Math.round(
                (snapshot.bytesTransferred / snapshot.totalBytes) * 100
              );
              setUploads((prev) =>
                prev.map((u) => (u.id === uploadId ? { ...u, progress: pct } : u))
              );
            },
            (err) => reject(err),
            () => resolve()
          );
        });

        // Get download URL
        const downloadUrl = await getDownloadURL(storageRef);

        // Create file document in Firestore (with hash)
        const fileId = await createFile(ctx, {
          fileName: file.name,
          fileType: file.type,
          fileSize: file.size,
          storagePath,
          downloadUrl,
          contentHash,
        });

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
    [ctx, calculateFileHash]
  );

  // Handle multiple file drops
  const handleFileDrop = useCallback(
    async (acceptedFiles: File[]) => {
      if (acceptedFiles.length === 0) return;

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
        router.push(`/files?${params.toString()}`, { scroll: false });
      }
    },
    [uploadSingleFile, router, filters, searchValue]
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

  // Find selected file (primary selection from URL)
  const selectedFile = useMemo(() => {
    if (!primarySelectedId || !files.length) return null;
    return files.find((f) => f.id === primarySelectedId) || null;
  }, [primarySelectedId, files]);

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

  // Find current index for navigation
  const currentIndex = useMemo(() => {
    if (!primarySelectedId) return -1;
    return files.findIndex((f) => f.id === primarySelectedId);
  }, [primarySelectedId, files]);

  const hasPrevious = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < files.length - 1;

  // Note: We intentionally do NOT close the viewer when navigating between files
  // The viewer should stay open so users can browse through files quickly

  // Load panel width from localStorage
  useEffect(() => {
    const saved = localStorage.getItem(PANEL_WIDTH_KEY);
    if (saved) {
      const parsed = parseInt(saved, 10);
      if (!isNaN(parsed) && parsed >= MIN_PANEL_WIDTH && parsed <= MAX_PANEL_WIDTH) {
        setPanelWidth(parsed);
      }
    }
  }, []);

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

  // Handle resize
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    resizeRef.current = { startX: e.clientX, startWidth: panelWidth };
  }, [panelWidth]);

  useEffect(() => {
    if (!isResizing) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!resizeRef.current || !panelRef.current) return;
      const delta = resizeRef.current.startX - e.clientX;
      const newWidth = Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, resizeRef.current.startWidth + delta));
      panelRef.current.style.width = `${newWidth}px`;
      currentWidthRef.current = newWidth;
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      setPanelWidth(currentWidthRef.current);
      localStorage.setItem(PANEL_WIDTH_KEY, currentWidthRef.current.toString());
      resizeRef.current = null;
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);

    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, [isResizing]);

  // URL update helpers using centralized utilities
  const handleSearchChange = useCallback(
    (value: string) => {
      const params = buildFileSearchParams(filters, value, primarySelectedId);
      const newUrl = params.toString() ? `/files?${params.toString()}` : "/files";
      router.replace(newUrl, { scroll: false });
    },
    [router, filters, primarySelectedId]
  );

  const handleFiltersChange = useCallback(
    (newFilters: FileFilters) => {
      const params = buildFileSearchParams(newFilters, searchValue, primarySelectedId);
      const newUrl = params.toString() ? `/files?${params.toString()}` : "/files";
      router.replace(newUrl, { scroll: false });
    },
    [router, searchValue, primarySelectedId]
  );

  const handleSelectFile = useCallback(
    (file: TaxFile) => {
      const params = buildFileSearchParams(filters, searchValue, file.id);
      router.push(`/files?${params.toString()}`, { scroll: false });
    },
    [router, filters, searchValue]
  );

  const handleCloseDetail = useCallback(() => {
    const params = buildFileSearchParams(filters, searchValue, null);
    const newUrl = params.toString() ? `/files?${params.toString()}` : "/files";
    router.push(newUrl, { scroll: false });
  }, [router, filters, searchValue]);

  const handleNavigatePrevious = useCallback(() => {
    if (currentIndex > 0) {
      handleSelectFile(files[currentIndex - 1]);
    }
  }, [currentIndex, files, handleSelectFile]);

  const handleNavigateNext = useCallback(() => {
    if (currentIndex >= 0 && currentIndex < files.length - 1) {
      handleSelectFile(files[currentIndex + 1]);
    }
  }, [currentIndex, files, handleSelectFile]);

  const handleDelete = useCallback(async () => {
    if (!selectedFile) return;
    const isGmailFile = selectedFile.sourceType?.startsWith("gmail");
    const message = isGmailFile
      ? `Delete "${selectedFile.fileName}"? It will be hidden but won't be re-imported from Gmail.`
      : `Permanently delete "${selectedFile.fileName}"? This will also remove all connections.`;
    if (!confirm(message)) return;
    // Use soft delete for Gmail files to prevent re-import
    await remove(selectedFile.id, isGmailFile);
    handleCloseDetail();
  }, [selectedFile, remove, handleCloseDetail]);

  const handleRestore = useCallback(async () => {
    if (!selectedFile) return;
    await restore(selectedFile.id);
  }, [selectedFile, restore]);

  const handleMarkAsNotInvoice = useCallback(async () => {
    if (!selectedFile) return;
    await markAsNotInvoice(selectedFile.id);
  }, [selectedFile, markAsNotInvoice]);

  const handleUnmarkAsNotInvoice = useCallback(async () => {
    if (!selectedFile) return;
    // Set parsing state FIRST before any Firestore updates (prevents race condition)
    setParsingFileId(selectedFile.id);
    // Unmark as not-invoice and trigger re-extraction (user says it IS an invoice)
    await unmarkAsNotInvoice(selectedFile.id);
    // Force re-extraction since user overrode the AI classification
    try {
      await retryFileExtraction(ctx, selectedFile.id);
    } catch (error) {
      console.error("Failed to re-extract after marking as invoice:", error);
      setParsingFileId(null);
    }
  }, [selectedFile, unmarkAsNotInvoice, ctx]);


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
      const params = new URLSearchParams();
      if (res.fileId) {
        params.set("id", res.fileId);
      } else {
        // Legacy response without fileId — fall back to invoiceId routing.
        params.set("invoiceId", res.invoiceId);
      }
      router.push(`/files?${params.toString()}`, { scroll: false });
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
    router.push(newUrl, { scroll: false });
  }, [router, searchParams]);

  const handleUploadComplete = useCallback(
    (fileId: string) => {
      setIsUploadDialogOpen(false);
      // Select the newly uploaded file
      const params = buildFileSearchParams(filters, searchValue, fileId);
      router.push(`/files?${params.toString()}`, { scroll: false });
    },
    [router, filters, searchValue]
  );

  // Multi-select: handle selection changes from table
  // This receives: { primaryId, additionalIds } from the table
  const handleSelectionChange = useCallback(
    (newSelectedIds: Set<string>) => {
      // The table sends us the full set of selected IDs
      // We need to figure out what changed

      // If exactly one ID and it's different from current primary, it's a new primary click
      if (newSelectedIds.size === 1) {
        const [id] = newSelectedIds;
        // Clear additional selections, update primary via URL
        setAdditionalSelectedIds(new Set());
        const params = buildFileSearchParams(filters, searchValue, id);
        router.push(`/files?${params.toString()}`, { scroll: false });
      } else if (newSelectedIds.size === 0) {
        // Clear everything
        setAdditionalSelectedIds(new Set());
        const params = buildFileSearchParams(filters, searchValue, null);
        const newUrl = params.toString() ? `/files?${params.toString()}` : "/files";
        router.push(newUrl, { scroll: false });
      } else {
        // Multiple selected - update additional selections (keep primary as-is)
        const newAdditional = new Set(newSelectedIds);
        if (primarySelectedId) {
          newAdditional.delete(primarySelectedId); // Primary is in URL, not in additional
        }
        setAdditionalSelectedIds(newAdditional);
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
    if (!confirm(`Delete ${allSelectedIds.size} files? This cannot be undone.`)) return;

    setIsBulkDeleting(true);
    try {
      const fileIds = Array.from(allSelectedIds);
      for (const fileId of fileIds) {
        const file = files.find((f) => f.id === fileId);
        const isGmailFile = file?.sourceType?.startsWith("gmail");
        await remove(fileId, isGmailFile);
      }
      // Clear additional selections and primary
      setAdditionalSelectedIds(new Set());
      const params = buildFileSearchParams(filters, searchValue, null);
      const newUrl = params.toString() ? `/files?${params.toString()}` : "/files";
      router.push(newUrl, { scroll: false });
    } finally {
      setIsBulkDeleting(false);
    }
  }, [allSelectedIds, files, remove, router, filters, searchValue]);

  // Multi-select: bulk mark as not invoice
  const handleBulkMarkAsNotInvoice = useCallback(async () => {
    if (allSelectedIds.size === 0) return;

    setIsBulkUpdating(true);
    try {
      for (const fileId of allSelectedIds) {
        await markAsNotInvoice(fileId);
      }
    } finally {
      setIsBulkUpdating(false);
    }
  }, [allSelectedIds, markAsNotInvoice]);

  // Multi-select: bulk mark as invoice (unmark as not invoice)
  const handleBulkMarkAsInvoice = useCallback(async () => {
    if (allSelectedIds.size === 0) return;

    setIsBulkUpdating(true);
    try {
      for (const fileId of allSelectedIds) {
        await unmarkAsNotInvoice(fileId);
        // Trigger re-extraction since user says it IS an invoice
        try {
          await retryFileExtraction(ctx, fileId);
        } catch (error) {
          console.error(`Failed to re-extract file ${fileId}:`, error);
        }
      }
    } finally {
      setIsBulkUpdating(false);
    }
  }, [allSelectedIds, unmarkAsNotInvoice, ctx]);

  if (loading) {
    return <FileTableFallback />;
  }

  return (
    <TooltipProvider>
      <div {...getRootProps()} className="h-full overflow-hidden relative">
        <input {...getInputProps()} />

      {/* Upload FAB — z-60 so it stays visible above the right-side detail panel (z-50) */}
      <Dialog open={isUploadDialogOpen} onOpenChange={setIsUploadDialogOpen}>
        <DialogTrigger asChild>
          <Button
            className="fixed bottom-6 right-6 z-[60] h-14 w-14 rounded-full shadow-lg"
            size="icon"
          >
            <Upload className="h-6 w-6" />
          </Button>
        </DialogTrigger>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Upload File</DialogTitle>
          </DialogHeader>
          <FileUploadZone onUploadComplete={handleUploadComplete} />
        </DialogContent>
      </Dialog>

      {/* Create Invoice FAB: opens an empty draft directly in the sidebar */}
      <Button
        variant="secondary"
        className="fixed bottom-24 right-6 z-[60] h-14 w-14 rounded-full shadow-lg"
        size="icon"
        title="Rechnung erstellen"
        onClick={handleCreateInvoice}
        disabled={creatingInvoice}
      >
        {creatingInvoice ? (
          <Loader2 className="h-6 w-6 animate-spin" />
        ) : (
          <FileText className="h-6 w-6" />
        )}
      </Button>

      {/* Main content */}
      <div
        className="h-full flex flex-col transition-[margin] duration-200 ease-in-out"
        style={{
          marginRight:
            selectedFile || showBulkPanel || invoiceIdParam ? panelWidth : 0,
        }}
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
            loading={loading}
            onSelectFile={handleSelectFile}
            selectedFileId={primarySelectedId}
            searchValue={searchValue}
            onSearchChange={handleSearchChange}
            filters={filters}
            onFiltersChange={handleFiltersChange}
            userPartners={userPartners}
            globalPartners={globalPartners}
            transactionAmountsMap={transactionAmountsMap}
            enableMultiSelect={true}
            selectedRowIds={allSelectedIds}
            onSelectionChange={handleSelectionChange}
            onUploadClick={() => setIsUploadDialogOpen(true)}
          />

          {/* File viewer overlay - positioned over table area only */}
          {selectedFile && viewerOpen && (
            <FileViewerOverlay
              open={viewerOpen}
              onClose={() => {
                setViewerOpen(false);
                setHighlightText(null);
              }}
              downloadUrl={selectedFile.downloadUrl}
              fileType={selectedFile.fileType}
              fileName={selectedFile.fileName}
              highlightText={highlightText}
            />
          )}

          {/* Connect transaction overlay - positioned over table area */}
          {selectedFile && (
            <ConnectTransactionOverlay
              open={isConnectTransactionOpen}
              onClose={closeConnectTransactionOverlay}
              onSelect={handleConnectTransactions}
              connectedTransactionIds={selectedFile.transactionIds}
              file={selectedFile}
              suggestions={selectedFile.transactionSuggestions}
            />
          )}
        </div>

        {/* Upload progress bar - sticky at bottom */}
        {showUploadProgress && uploads.length > 0 && (
          <UploadProgress uploads={uploads} onDismiss={handleDismissProgress} />
        )}
      </div>

      {/* Right sidebar - Invoice editor takes priority when invoiceId param set */}
      {invoiceIdParam ? (
        <div
          ref={panelRef}
          className="fixed right-0 top-14 bottom-0 z-50 bg-background border-l flex"
          style={{ width: panelWidth }}
        >
          <div
            className={cn(
              "w-1 cursor-col-resize bg-border hover:bg-primary/20 active:bg-primary/30 flex-shrink-0",
              isResizing && "bg-primary/30"
            )}
            onMouseDown={handleResizeStart}
          />
          <div className="flex-1 overflow-hidden detail-panel-container">
            <InvoiceDetailPanel
              invoiceId={invoiceIdParam}
              onClose={handleCloseInvoice}
            />
          </div>
        </div>
      ) : showBulkPanel ? (
        <div
          ref={panelRef}
          className="fixed right-0 top-14 bottom-0 z-50 bg-background border-l flex"
          style={{ width: panelWidth }}
        >
          {/* Resize handle */}
          <div
            className={cn(
              "w-1 cursor-col-resize bg-border hover:bg-primary/20 active:bg-primary/30 flex-shrink-0",
              isResizing && "bg-primary/30"
            )}
            onMouseDown={handleResizeStart}
          />
          {/* Bulk actions panel content */}
          <div className="flex-1 overflow-hidden">
            <FileBulkActionsPanel
              selectedFiles={selectedFiles}
              onDelete={handleBulkDelete}
              onMarkAsNotInvoice={handleBulkMarkAsNotInvoice}
              onMarkAsInvoice={handleBulkMarkAsInvoice}
              onClearSelection={handleClearSelection}
              isDeleting={isBulkDeleting}
              isUpdating={isBulkUpdating}
            />
          </div>
        </div>
      ) : selectedFile && (
        <div
          ref={panelRef}
          className="fixed right-0 top-14 bottom-0 z-50 bg-background border-l flex"
          style={{ width: panelWidth }}
        >
          {/* Resize handle */}
          <div
            className={cn(
              "w-1 cursor-col-resize bg-border hover:bg-primary/20 active:bg-primary/30 flex-shrink-0",
              isResizing && "bg-primary/30"
            )}
            onMouseDown={handleResizeStart}
          />
          {/* Panel content */}
          <div className="flex-1 overflow-hidden detail-panel-container">
            <FileDetailPanel
              file={selectedFile}
              onClose={handleCloseDetail}
              onNavigatePrevious={handleNavigatePrevious}
              onNavigateNext={handleNavigateNext}
              hasPrevious={hasPrevious}
              hasNext={hasNext}
              onDelete={handleDelete}
              onRestore={handleRestore}
              onMarkAsNotInvoice={handleMarkAsNotInvoice}
              onUnmarkAsNotInvoice={handleUnmarkAsNotInvoice}
              isParsing={parsingFileId === selectedFile.id}
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
            />
          </div>
        </div>
      )}

        {/* Prevent text selection while resizing */}
        {isResizing && (
          <div className="fixed inset-0 z-50 cursor-col-resize" />
        )}
      </div>
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
