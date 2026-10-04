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
import { getNeighbourRowId } from "@/lib/navigation/row-neighbour";
import { useRowNavigationKeys } from "@/hooks/use-row-navigation-keys";
import { isRowNavigationEnabled } from "@/lib/navigation/arrow-key-navigation";
import { functions, storage, db } from "@/lib/firebase/config";
import { createFile, checkFileDuplicate, OperationsContext } from "@/lib/operations";
import { useAuth } from "@/components/auth";
import {
  parseFiltersFromUrl,
  filterQueryKey,
  saveFiltersToStorage,
  loadFiltersFromStorage,
  buildSearchParamsString,
  hasUrlParams,
} from "@/lib/filters/url-params";
import { Skeleton } from "@/components/ui/skeleton";
import { Transaction, type TransactionUpdate } from "@/types/transaction";
import { DetailPanelLayout } from "@/components/ui/detail-panel-layout";

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


  // Connect file overlay state - driven by URL param
  const isConnectFileOpen = searchParams.get("connect") === "true";

  // Restore filters from localStorage on initial mount if no URL params
  const hasRestoredRef = useRef(false);
  // Track latest patternsUpdatedAt to detect when new patterns are learned
  const lastPatternsUpdatedAtRef = useRef(null as number | null);
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
        replaceQuery(router, `/transactions?${paramsString}`);
      }
    }
  }, [router, searchParams]);

  // Get search value from URL
  const searchValue = searchParams.get("search") || "";

  // Parse filters from URL
  // Keyed on the filter params only, so selecting a row (the `id` param) does
  // not hand the list a new filters object (lib/filters/url-params.ts).
  const filterKey = filterQueryKey(searchParams);
  const filters = useMemo(() => parseFiltersFromUrl(new URLSearchParams(filterKey)), [filterKey]);

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
      replaceQuery(router, newUrl);
    },
    [router]
  );
  const tableRef = useRef<DataTableHandle>(null);

  // Get selected transaction ID from URL
  const selectedId = searchParams.get("id");

  // Get filtered transactions
  const filteredTransactions = useFilteredTransactions(transactions, filters, searchValue);

  // The order the table paints: filters and search fold into the rows it is
  // given, the sort column and direction are its own state, so it reports them
  // back here. Prev/next walks this list, falling back to the filtered order
  // until the table has reported (first paint, or behind the loading skeleton).
  const [tableOrderedIds, setTableOrderedIds] = useState<string[]>([]);
  const orderedTransactionIds = useMemo(
    () =>
      tableOrderedIds.length
        ? tableOrderedIds
        : filteredTransactions.map((t) => t.id),
    [tableOrderedIds, filteredTransactions]
  );

  const hasPrevious =
    getNeighbourRowId(orderedTransactionIds, selectedId, -1) !== null;
  const hasNext = getNeighbourRowId(orderedTransactionIds, selectedId, 1) !== null;

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
  // `fileId` opens it on a suggested File, selected and previewed (#555).
  const openConnectFileOverlay = useCallback((fileId?: string) => {
    const params = new URLSearchParams(searchParamsRef.current.toString());
    params.set("connect", "true");
    if (fileId) params.set("connectFile", fileId);
    else params.delete("connectFile");
    pushQuery(router, `/transactions?${params.toString()}`);
  }, [router]);

  const closeConnectFileOverlay = useCallback(() => {
    const params = new URLSearchParams(searchParamsRef.current.toString());
    params.delete("connect");
    params.delete("connectFile");
    pushQuery(router, `/transactions?${params.toString()}`);
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

  // Select transaction (update URL)
  const handleSelectTransaction = useCallback(
    (transaction: Transaction, options?: { keepConnect?: boolean }) => {
      const params = new URLSearchParams(searchParamsRef.current.toString());
      params.set("id", transaction.id);
      // A suggested File belongs to the Transaction it was suggested for (#555).
      params.delete("connectFile");
      if (!options?.keepConnect) {
        params.delete("connect");
      }
      pushQuery(router, `/transactions?${params.toString()}`);
    },
    [router]
  );

  // Close detail panel (remove ID from URL)
  const handleCloseDetail = useCallback(() => {
    const params = new URLSearchParams(searchParamsRef.current.toString());
    params.delete("id");
    params.delete("connect");
    params.delete("connectFile");
    const newUrl = params.toString()
      ? `/transactions?${params.toString()}`
      : "/transactions";
    pushQuery(router, newUrl);
  }, [router]);

  // Update transaction
  const handleTransactionUpdate = useCallback(
    async (updates: TransactionUpdate) => {
      if (!selectedTransaction) return;
      await updateTransaction(selectedTransaction.id, updates);
    },
    [selectedTransaction, updateTransaction]
  );

  // Step through the displayed order (-1 previous, 1 next)
  const navigateTransactionBy = useCallback(
    (step: number) => {
      const targetId = getNeighbourRowId(orderedTransactionIds, selectedId, step);
      const target = targetId ? transactions.find((t) => t.id === targetId) : undefined;
      if (target) handleSelectTransaction(target, { keepConnect: true });
    },
    [orderedTransactionIds, selectedId, transactions, handleSelectTransaction]
  );

  const handleNavigatePrevious = useCallback(
    () => navigateTransactionBy(-1),
    [navigateTransactionBy]
  );

  const handleNavigateNext = useCallback(
    () => navigateTransactionBy(1),
    [navigateTransactionBy]
  );

  // Left/right walk the displayed order while the transaction panel is open.
  // The connect-file overlay renders inline with no dialog role of its own, so
  // it has to be named here; portalled dialogs and menus the hook sees itself.
  useRowNavigationKeys({
    enabled: isRowNavigationEnabled({
      panelOpen: Boolean(selectedTransaction),
      connectOverlayOpen: isConnectFileOpen,
    }),
    onPrevious: handleNavigatePrevious,
    onNext: handleNavigateNext,
  });


  // Mid-session: learned patterns changed while the page is open (a Partner
  // was just taught something), so re-match the unassigned Transactions now.
  // The load itself is the catch-up's job, so the first signal is only noted.
  useEffect(() => {
    if (loading || !transactions.length || !partners.length) return;

    const signal = patternSignal(partners);
    if (lastPatternsUpdatedAtRef.current === null) {
      lastPatternsUpdatedAtRef.current = signal;
      return;
    }
    if (signal === lastPatternsUpdatedAtRef.current) return;

    const previous = lastPatternsUpdatedAtRef.current;
    lastPatternsUpdatedAtRef.current = signal;
    if (!transactions.some((t) => !t.partnerId)) return;

    console.log(`[Partner Matching] Pattern signal changed: ${previous} → ${signal}`);
    const matchPartnersFunc = httpsCallable(functions, "matchPartners");
    matchPartnersFunc({ matchAll: false }) // matchAll: false = only unassigned
      .then((result) => {
        const data = result.data as { processed: number; autoMatched: number; withSuggestions: number };
        console.log(`[Partner Matching] Result: processed=${data.processed}, autoMatched=${data.autoMatched}, suggestions=${data.withSuggestions}`);
      })
      .catch((error) => {
        console.error("Background partner matching failed:", error);
        // Allow a retry on the next change
        lastPatternsUpdatedAtRef.current = previous;
      });
  }, [loading, transactions, partners]);

  // --- Global drag & drop (table area) ---
  const { userId } = useAuth();

  // Once per visit, in the background: the server re-matches unassigned
  // Transactions only if the Global Partner directory or this user's learned
  // patterns changed since its last run (catchUpPartnerMatching). Before, this
  // page re-matched every unassigned Transaction on every visit.
  const catchUpRequestedRef = useRef(false);
  useEffect(() => {
    if (catchUpRequestedRef.current || !userId) return;
    catchUpRequestedRef.current = true;
    callFunction("catchUpPartnerMatching", null).catch((error) => {
      console.error("Partner matching catch-up failed:", error);
    });
  }, [userId]);
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
      <DetailPanelLayout
        storageKey={PANEL_WIDTH_KEY}
        defaultWidth={DEFAULT_PANEL_WIDTH}
        minWidth={MIN_PANEL_WIDTH}
        maxWidth={MAX_PANEL_WIDTH}
        open={!!selectedTransaction}
        mainProps={getGlobalRootProps()}
        panel={
          selectedTransaction ? (
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
              onPreviewSuggestedFile={openConnectFileOverlay}
              isConnectFileOpen={isConnectFileOpen}
            />
          ) : null
        }
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
            onDisplayedOrderChange={setTableOrderedIds}
          />

          {/* Connect file overlay - positioned over table area. Mounted only
              while open: it renders nothing when closed, but its hooks ran on
              every row selection. */}
          {selectedTransaction && isConnectFileOpen && (
            <ConnectFileOverlay
              open={isConnectFileOpen}
              onClose={closeConnectFileOverlay}
              onSelect={handleConnectFile}
              connectedFileIds={connectedFileIds}
              transaction={selectedTransaction}
              initialFileId={searchParams.get("connectFile")}
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
      </DetailPanelLayout>

      {/* Onboarding guide - show when no transaction selected */}
      {!selectedTransaction && <TransactionSelectionGuide />}
    </div>
  );
}

import { PrecisionSearchProvider } from "@/hooks/use-precision-search-context";
import { usePageTitle } from "@/hooks/use-page-title";
import { pushQuery, replaceQuery } from "@/lib/navigation/query-url";
import { patternSignal } from "@/functions/src/matching/patternSignal";
import { callFunction } from "@/lib/firebase/callable";

export default function TransactionsPage() {
  return (
    <PrecisionSearchProvider>
      <Suspense fallback={<TransactionTableFallback />}>
        <TransactionsContent />
      </Suspense>
    </PrecisionSearchProvider>
  );
}
