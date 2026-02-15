"use client";

import { Suspense, useState, useEffect, useCallback, useMemo, useRef } from "react";
import { DataTableHandle } from "@/components/transactions/data-table";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { httpsCallable } from "firebase/functions";
import { useDropzone } from "react-dropzone";
import { ref, uploadBytesResumable, getDownloadURL } from "firebase/storage";
import { Upload, CheckCircle2 } from "lucide-react";
import { TransactionTable } from "@/components/transactions/transaction-table";
import { TransactionDetailPanel } from "@/components/transactions/transaction-detail-panel";
import { ConnectFileOverlay } from "@/components/files/connect-file-overlay";
import { TransactionSelectionGuide } from "@/components/onboarding";
import { useTransactions } from "@/hooks/use-transactions";
import { useSources } from "@/hooks/use-sources";
import { usePartners } from "@/hooks/use-partners";
import { useGlobalPartners } from "@/hooks/use-global-partners";
import { useFilteredTransactions } from "@/hooks/use-filtered-transactions";
import { useTransactionFiles } from "@/hooks/use-files";
import { functions, storage, db } from "@/lib/firebase/config";
import { createFile, checkFileDuplicate, OperationsContext } from "@/lib/operations";
import { useAuth } from "@/components/auth";
import {
  parseFiltersFromUrl,
  saveFiltersToStorage,
  loadFiltersFromStorage,
  buildSearchParamsString,
  hasUrlParams,
} from "@/lib/filters/url-params";
import { Skeleton } from "@/components/ui/skeleton";
import { Transaction } from "@/types/transaction";
import { cn } from "@/lib/utils";

const PANEL_WIDTH_KEY = "transactionDetailPanelWidth";
const DEFAULT_PANEL_WIDTH = 480;
const MIN_PANEL_WIDTH = 280;
const MAX_PANEL_WIDTH = 700;

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ACCEPTED_TYPES = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "application/pdf": [".pdf"],
};

function TransactionTableFallback() {
  return (
    <div className="h-full flex flex-col overflow-hidden bg-card">
      {/* Toolbar skeleton */}
      <div className="flex items-center gap-2 px-4 py-2 border-b">
        <Skeleton className="h-9 w-[300px]" />
        <Skeleton className="h-9 w-[100px]" />
      </div>
      {/* Table header skeleton */}
      <div className="flex items-center gap-2 px-4 h-10 border-b bg-muted">
        <Skeleton className="h-4 w-[50px]" />
        <Skeleton className="h-4 w-[55px]" />
        <Skeleton className="h-4 w-[80px]" />
        <Skeleton className="h-4 w-[50px]" />
        <Skeleton className="h-4 w-[30px]" />
        <Skeleton className="h-4 w-[55px]" />
      </div>
      {/* Table rows skeleton */}
      <div className="flex-1">
        {[...Array(15)].map((_, i) => (
          <div
            key={i}
            className="flex items-center gap-2 px-4 border-b last:border-b-0"
            style={{ height: 64 }}
          >
            <Skeleton className="h-5 w-[64px]" />
            <Skeleton className="h-5 w-[64px]" />
            <Skeleton className="h-5 w-[200px]" />
            <Skeleton className="h-5 w-[100px] rounded-full" />
            <Skeleton className="h-4 w-4" />
            <Skeleton className="h-5 w-[100px]" />
          </div>
        ))}
      </div>
    </div>
  );
}

function TransactionsContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Keep searchParams in a ref to avoid callback recreation on every URL change
  const searchParamsRef = useRef(searchParams);
  useEffect(() => {
    searchParamsRef.current = searchParams;
  }, [searchParams]);

  const { transactions, loading, error, updateTransaction } = useTransactions();
  const { sources } = useSources();
  const { partners, createPartner, assignToTransaction, removeFromTransaction } = usePartners();
  const { globalPartners } = useGlobalPartners();

  const [panelWidth, setPanelWidth] = useState<number>(DEFAULT_PANEL_WIDTH);
  const [isResizing, setIsResizing] = useState(false);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Connect file overlay state - driven by URL param
  const isConnectFileOpen = searchParams.get("connect") === "true";

  // Restore filters from localStorage on initial mount if no URL params
  const hasRestoredRef = useRef(false);
  // Track latest patternsUpdatedAt to detect when new patterns are learned
  const lastPatternsUpdatedAtRef = useRef(0);
  useEffect(() => {
    if (hasRestoredRef.current) return;
    hasRestoredRef.current = true;

    // If navigating directly to a transaction (only id param), don't restore filters
    // This ensures the transaction is visible in the list
    const hasOnlyIdParam = searchParams.has("id") && !hasUrlParams(searchParams);
    if (hasOnlyIdParam) return;

    // Only restore if URL has no filter/search params
    if (!hasUrlParams(searchParams)) {
      const { filters: savedFilters, search: savedSearch } =
        loadFiltersFromStorage();
      const paramsString = buildSearchParamsString(savedFilters, savedSearch);
      if (paramsString) {
        router.replace(`/transactions?${paramsString}`, { scroll: false });
      }
    }
  }, [router, searchParams]);

  // Get search value from URL
  const searchValue = searchParams.get("search") || "";

  // Parse filters from URL
  const filters = useMemo(() => parseFiltersFromUrl(searchParams), [searchParams]);

  // Save filters to localStorage whenever they change
  useEffect(() => {
    saveFiltersToStorage(filters, searchValue);
  }, [filters, searchValue]);

  // Update search in URL
  const handleSearchChange = useCallback(
    (value: string) => {
      const params = new URLSearchParams(searchParamsRef.current.toString());
      if (value) {
        params.set("search", value);
      } else {
        params.delete("search");
      }
      const newUrl = params.toString()
        ? `/transactions?${params.toString()}`
        : "/transactions";
      router.replace(newUrl, { scroll: false });
    },
    [router]
  );
  const panelRef = useRef<HTMLDivElement>(null);
  const currentWidthRef = useRef(panelWidth);
  const tableRef = useRef<DataTableHandle>(null);

  // Get selected transaction ID from URL
  const selectedId = searchParams.get("id");

  // Get filtered transactions
  const filteredTransactions = useFilteredTransactions(transactions, filters, searchValue);

  // Find current index in filtered list for navigation
  const currentIndex = useMemo(() => {
    if (!selectedId) return -1;
    return filteredTransactions.findIndex((t) => t.id === selectedId);
  }, [selectedId, filteredTransactions]);

  const hasPrevious = currentIndex > 0;
  const hasNext = currentIndex >= 0 && currentIndex < filteredTransactions.length - 1;

  // Find selected transaction
  const selectedTransaction = useMemo(() => {
    if (!selectedId || !transactions.length) return null;
    return transactions.find((t) => t.id === selectedId) || null;
  }, [selectedId, transactions]);

  // Set page title
  usePageTitle("Transactions", selectedTransaction?.description);

  // Find source for selected transaction
  const selectedSource = useMemo(() => {
    if (!selectedTransaction) return undefined;
    return sources.find((s) => s.id === selectedTransaction.sourceId);
  }, [selectedTransaction, sources]);

  // Get files connected to selected transaction (for overlay)
  const { files: connectedFiles, connectFile } = useTransactionFiles(selectedTransaction?.id || "");
  const connectedFileIds = useMemo(() => connectedFiles.map(f => f.id), [connectedFiles]);

  // Open/close connect file overlay via URL param
  const openConnectFileOverlay = useCallback(() => {
    const params = new URLSearchParams(searchParamsRef.current.toString());
    params.set("connect", "true");
    router.push(`/transactions?${params.toString()}`, { scroll: false });
  }, [router]);

  const closeConnectFileOverlay = useCallback(() => {
    const params = new URLSearchParams(searchParamsRef.current.toString());
    params.delete("connect");
    router.push(`/transactions?${params.toString()}`, { scroll: false });
  }, [router]);

  const toggleConnectFileOverlay = useCallback(() => {
    if (isConnectFileOpen) {
      closeConnectFileOverlay();
    } else {
      openConnectFileOverlay();
    }
  }, [isConnectFileOpen, openConnectFileOverlay, closeConnectFileOverlay]);

  // Handle connect file from overlay
  const handleConnectFile = useCallback(
    async (
      fileId: string,
      sourceInfo?: Parameters<typeof connectFile>[1]
    ) => {
      if (!selectedTransaction) return;
      await connectFile(fileId, sourceInfo);
      closeConnectFileOverlay();
    },
    [selectedTransaction, connectFile, closeConnectFileOverlay]
  );

  // Close overlay when transaction is deselected

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
      // Update DOM directly during drag - no React re-render
      panelRef.current.style.width = `${newWidth}px`;
      currentWidthRef.current = newWidth;
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      // Commit to state only on drag end
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

  // Select transaction (update URL)
  const handleSelectTransaction = useCallback(
    (transaction: Transaction, options?: { keepConnect?: boolean }) => {
      const params = new URLSearchParams(searchParamsRef.current.toString());
      params.set("id", transaction.id);
      if (!options?.keepConnect) {
        params.delete("connect");
      }
      router.push(`/transactions?${params.toString()}`, { scroll: false });
    },
    [router]
  );

  // Close detail panel (remove ID from URL)
  const handleCloseDetail = useCallback(() => {
    const params = new URLSearchParams(searchParamsRef.current.toString());
    params.delete("id");
    params.delete("connect");
    const newUrl = params.toString()
      ? `/transactions?${params.toString()}`
      : "/transactions";
    router.push(newUrl, { scroll: false });
  }, [router]);

  // Update transaction
  const handleTransactionUpdate = useCallback(
    async (updates: Partial<Transaction>) => {
      if (!selectedTransaction) return;
      await updateTransaction(selectedTransaction.id, updates);
    },
    [selectedTransaction, updateTransaction]
  );

  // Navigate to previous transaction
  const handleNavigatePrevious = useCallback(() => {
    if (currentIndex > 0) {
      const prevTransaction = filteredTransactions[currentIndex - 1];
      handleSelectTransaction(prevTransaction, { keepConnect: true });
    }
  }, [currentIndex, filteredTransactions, handleSelectTransaction]);

  // Navigate to next transaction
  const handleNavigateNext = useCallback(() => {
    if (currentIndex >= 0 && currentIndex < filteredTransactions.length - 1) {
      const nextTransaction = filteredTransactions[currentIndex + 1];
      handleSelectTransaction(nextTransaction, { keepConnect: true });
    }
  }, [currentIndex, filteredTransactions, handleSelectTransaction]);

  // Trigger backend matching when patterns change or on initial load
  useEffect(() => {
    if (loading || !transactions.length || !partners.length) return;

    const currentPatternsUpdatedAt = partners.reduce((max, p) => {
      const millis = typeof p.patternsUpdatedAt?.toMillis === "function"
        ? p.patternsUpdatedAt.toMillis()
        : 0;
      return Math.max(max, millis);
    }, 0);
    const hasPatternsUpdatedAt = partners.some((p) => !!p.patternsUpdatedAt);
    const currentPatternCount = partners.reduce(
      (sum, p) => sum + (p.learnedPatterns?.length || 0),
      0
    );
    const patternSignal = hasPatternsUpdatedAt ? currentPatternsUpdatedAt : currentPatternCount;

    // Skip if pattern signal hasn't changed (already processed this state)
    if (patternSignal === lastPatternsUpdatedAtRef.current) return;

    // Check if there are unassigned transactions
    const unassignedCount = transactions.filter(t => !t.partnerId).length;
    if (unassignedCount === 0) {
      lastPatternsUpdatedAtRef.current = patternSignal;
      return;
    }

    console.log(`[Partner Matching] Pattern signal changed: ${lastPatternsUpdatedAtRef.current} → ${patternSignal}, unassigned: ${unassignedCount}`);

    // Update ref to prevent duplicate calls for same pattern count
    lastPatternsUpdatedAtRef.current = patternSignal;

    // Call backend to match all unassigned transactions
    const matchPartnersFunc = httpsCallable(functions, "matchPartners");
    matchPartnersFunc({ matchAll: false }) // matchAll: false = only unassigned
      .then((result) => {
        const data = result.data as { processed: number; autoMatched: number; withSuggestions: number };
        console.log(`[Partner Matching] Result: processed=${data.processed}, autoMatched=${data.autoMatched}, suggestions=${data.withSuggestions}`);
      })
      .catch((error) => {
        console.error("Background partner matching failed:", error);
        // Reset to allow retry
        lastPatternsUpdatedAtRef.current = 0;
      });
  }, [loading, transactions, partners]);

  // --- Global drag & drop (table area) ---
  const { userId } = useAuth();
  const [uploadSuccessMsg, setUploadSuccessMsg] = useState<string | null>(null);
  const [globalUploading, setGlobalUploading] = useState(false);

  const opsCtx: OperationsContext = useMemo(
    () => ({ db, userId: userId ?? "" }),
    [userId]
  );

  const handleGlobalDrop = useCallback(
    async (acceptedFiles: File[]) => {
      if (acceptedFiles.length === 0 || !userId) return;
      const file = acceptedFiles[0];
      setGlobalUploading(true);
      try {
        const buffer = await file.arrayBuffer();
        const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
        const contentHash = Array.from(new Uint8Array(hashBuffer))
          .map((b) => b.toString(16).padStart(2, "0"))
          .join("");

        const existingFile = await checkFileDuplicate(opsCtx, contentHash);
        if (existingFile) {
          setUploadSuccessMsg("File already exists.");
        } else {
          const timestamp = Date.now();
          const sanitizedName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_");
          const storagePath = `files/${userId}/${timestamp}_${sanitizedName}`;
          const storageRef = ref(storage, storagePath);
          const uploadTask = uploadBytesResumable(storageRef, file);

          await new Promise<void>((resolve, reject) => {
            uploadTask.on("state_changed", null, reject, () => resolve());
          });

          const downloadUrl = await getDownloadURL(storageRef);
          await createFile(opsCtx, {
            fileName: file.name,
            fileType: file.type,
            fileSize: file.size,
            storagePath,
            downloadUrl,
            contentHash,
          });
          setUploadSuccessMsg("File uploaded successfully.");
        }
      } catch (err) {
        console.error("Global file upload failed:", err);
        setUploadSuccessMsg(null);
      } finally {
        setGlobalUploading(false);
      }
    },
    [opsCtx, userId]
  );

  // Auto-dismiss success banner
  useEffect(() => {
    if (!uploadSuccessMsg) return;
    const timer = setTimeout(() => setUploadSuccessMsg(null), 4000);
    return () => clearTimeout(timer);
  }, [uploadSuccessMsg]);

  const {
    getRootProps: getGlobalRootProps,
    getInputProps: getGlobalInputProps,
    isDragActive: isGlobalDragActive,
  } = useDropzone({
    onDrop: handleGlobalDrop,
    accept: ACCEPTED_TYPES,
    maxSize: MAX_FILE_SIZE,
    multiple: false,
    noClick: true,
    noKeyboard: true,
    disabled: globalUploading,
  });

  if (loading) {
    return <TransactionTableFallback />;
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-center max-w-md p-6">
          <p className="text-destructive font-medium mb-2">Failed to load transactions</p>
          <p className="text-sm text-muted-foreground mb-4">{error.message}</p>
          <button
            onClick={() => window.location.reload()}
            className="text-sm text-primary hover:underline"
          >
            Refresh page
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-hidden">
      {/* Main content - adjusts margin when panel is open */}
      <div
        {...getGlobalRootProps()}
        className="h-full transition-[margin] duration-200 ease-in-out"
        style={{ marginRight: selectedTransaction ? panelWidth : 0 }}
      >
        <input {...getGlobalInputProps()} />
        {/* Relative container for overlay positioning — overflow-hidden clips drag overlay to visible table area */}
        <div className="h-full relative overflow-hidden">
          <TransactionTable
            tableRef={tableRef}
            onSelectTransaction={handleSelectTransaction}
            selectedTransactionId={selectedId}
            searchValue={searchValue}
            onSearchChange={handleSearchChange}
            userPartners={partners}
            globalPartners={globalPartners}
          />

          {/* Connect file overlay - positioned over table area */}
          {selectedTransaction && (
            <ConnectFileOverlay
              open={isConnectFileOpen}
              onClose={closeConnectFileOverlay}
              onSelect={handleConnectFile}
              connectedFileIds={connectedFileIds}
              transaction={selectedTransaction}
            />
          )}

          {/* Global drag overlay */}
          {isGlobalDragActive && (
            <div className="absolute inset-0 z-40 bg-primary/10 border-2 border-dashed border-primary flex items-center justify-center pointer-events-none">
              <div className="bg-background rounded-lg p-6 shadow-lg text-center">
                <Upload className="h-12 w-12 mx-auto text-primary mb-2" />
                <p className="text-lg font-medium">Drop to upload receipt</p>
                <p className="text-sm text-muted-foreground">PDF, JPG, PNG, or WebP up to 10MB</p>
              </div>
            </div>
          )}

          {/* Upload success banner */}
          {uploadSuccessMsg && (
            <div className="absolute bottom-4 left-4 right-4 z-40 bg-green-50 dark:bg-green-950/30 border border-green-200 dark:border-green-900 rounded-lg px-4 py-3 flex items-center gap-2 shadow-md animate-in slide-in-from-bottom-2 duration-200">
              <CheckCircle2 className="h-4 w-4 text-green-600 dark:text-green-400 flex-shrink-0" />
              <span className="text-sm text-green-800 dark:text-green-200 flex-1">
                {uploadSuccessMsg}{" "}
                <Link href="/files" className="underline font-medium hover:text-green-900 dark:hover:text-green-100">
                  View in Files
                </Link>
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Onboarding guide - show when no transaction selected */}
      {!selectedTransaction && <TransactionSelectionGuide />}

      {/* Right sidebar - fixed position, z-50 to stay above overlays */}
      {selectedTransaction && (
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
            <TransactionDetailPanel
              transaction={selectedTransaction}
              source={selectedSource}
              onClose={handleCloseDetail}
              onUpdate={handleTransactionUpdate}
              onNavigatePrevious={handleNavigatePrevious}
              onNavigateNext={handleNavigateNext}
              hasPrevious={hasPrevious}
              hasNext={hasNext}
              partners={partners}
              globalPartners={globalPartners}
              onAssignPartner={assignToTransaction}
              onRemovePartner={removeFromTransaction}
              onCreatePartner={createPartner}
              onOpenConnectFile={toggleConnectFileOverlay}
              isConnectFileOpen={isConnectFileOpen}
            />
          </div>
        </div>
      )}

      {/* Prevent text selection while resizing */}
      {isResizing && (
        <div className="fixed inset-0 z-50 cursor-col-resize" />
      )}
    </div>
  );
}

import { PrecisionSearchProvider } from "@/hooks/use-precision-search-context";
import { usePageTitle } from "@/hooks/use-page-title";

export default function TransactionsPage() {
  return (
    <PrecisionSearchProvider>
      <Suspense fallback={<TransactionTableFallback />}>
        <TransactionsContent />
      </Suspense>
    </PrecisionSearchProvider>
  );
}
