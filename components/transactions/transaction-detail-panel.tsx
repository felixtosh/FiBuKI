"use client";

import { useCallback, useState, useMemo } from "react";
import { useDropzone } from "react-dropzone";
import { ref, uploadBytesResumable, getDownloadURL } from "firebase/storage";
import { Upload, Loader2, History, X } from "lucide-react";
import { storage, db } from "@/lib/firebase/config";
import {
  createFile,
  connectFileToTransaction,
  checkFileDuplicate,
  OperationsContext,
} from "@/lib/operations";
import { Transaction } from "@/types/transaction";
import { TransactionSource } from "@/types/source";
import { TransactionDetails } from "@/components/sidebar/transaction-details";
import { TransactionFilesSection } from "@/components/transactions/transaction-files-section";
import { TransactionHistory } from "@/components/sidebar/transaction-history";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Button } from "@/components/ui/button";
import {
  PanelHeader,
  PanelFooter,
  SectionDivider,
} from "@/components/ui/detail-panel-primitives";
import { UserPartner, GlobalPartner, PartnerFormData } from "@/types/partner";
import { usePrecisionSearch } from "@/hooks/use-precision-search";
import { useAuth } from "@/components/auth";
import { useChat } from "@/components/chat/chat-provider";
import { useBrowserLearnMode } from "@/hooks/use-browser-learn-mode";
import { useBrowserReplayMode } from "@/hooks/use-browser-replay-mode";
import { useBrowserExtensionStatus } from "@/hooks/use-browser-extension";

// Constants for file upload
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ACCEPTED_TYPES = {
  "image/jpeg": [".jpg", ".jpeg"],
  "image/png": [".png"],
  "image/webp": [".webp"],
  "application/pdf": [".pdf"],
};

interface TransactionDetailPanelProps {
  transaction: Transaction;
  source?: TransactionSource;
  onClose: () => void;
  onUpdate: (updates: Partial<Transaction>) => Promise<void>;
  onNavigatePrevious?: () => void;
  onNavigateNext?: () => void;
  hasPrevious?: boolean;
  hasNext?: boolean;
  partners: UserPartner[];
  globalPartners: GlobalPartner[];
  onAssignPartner: (transactionId: string, partnerId: string, partnerType: "global" | "user", matchedBy: "manual" | "suggestion", confidence?: number) => Promise<void>;
  onRemovePartner: (transactionId: string) => Promise<void>;
  onCreatePartner: (data: PartnerFormData) => Promise<string>;
  /** Open the connect file overlay (managed at page level) */
  onOpenConnectFile?: () => void;
  /** Whether the connect file overlay is open */
  isConnectFileOpen?: boolean;
}

export function TransactionDetailPanel({
  transaction,
  source,
  onClose,
  onUpdate,
  onNavigatePrevious,
  onNavigateNext,
  hasPrevious = false,
  hasNext = false,
  partners,
  globalPartners,
  onAssignPartner,
  onRemovePartner,
  onCreatePartner,
  onOpenConnectFile,
  isConnectFileOpen = false,
}: TransactionDetailPanelProps) {
  const { userId } = useAuth();

  // Browser learn mode
  const learnMode = useBrowserLearnMode();
  const replayMode = useBrowserReplayMode();
  const { status: extensionStatus } = useBrowserExtensionStatus();
  const extensionInstalled = extensionStatus === "installed";

  // Get partner name, website, and recipes for learn/replay mode
  const { partnerName, partnerWebsite } = useMemo(() => {
    if (!transaction.partnerId) return { partnerName: "", partnerWebsite: "" };
    const userPartner = partners.find((p) => p.id === transaction.partnerId);
    if (userPartner) return { partnerName: userPartner.name, partnerWebsite: userPartner.website || "" };
    const globalPartner = globalPartners.find((p) => p.id === transaction.partnerId);
    if (globalPartner) return { partnerName: globalPartner.name, partnerWebsite: globalPartner.website || "" };
    return { partnerName: transaction.partner || "", partnerWebsite: "" };
  }, [transaction.partnerId, transaction.partner, partners, globalPartners]);

  // Get browser recipes for the current partner
  const partnerRecipes = useMemo(() => {
    if (!transaction.partnerId) return [];
    const userPartner = partners.find((p) => p.id === transaction.partnerId);
    return userPartner?.browserRecipes || [];
  }, [transaction.partnerId, partners]);

  // Handler for assigning a partner to the transaction
  const handleAssignPartner = useCallback(
    async (
      partnerId: string,
      partnerType: "global" | "user",
      matchedBy: "manual" | "suggestion" | "auto",
      confidence?: number
    ) => {
      await onAssignPartner(transaction.id, partnerId, partnerType, matchedBy as "manual" | "suggestion", confidence);
    },
    [onAssignPartner, transaction.id]
  );

  // Handler for removing a partner from the transaction
  const handleRemovePartner = useCallback(async () => {
    await onRemovePartner(transaction.id);
  }, [onRemovePartner, transaction.id]);

  // Handler for creating a new partner
  const handleCreatePartner = useCallback(
    async (data: PartnerFormData): Promise<string> => {
      return onCreatePartner(data);
    },
    [onCreatePartner]
  );

  // File upload state
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  // Edit history expanded state
  const [showHistoryPanel, setShowHistoryPanel] = useState(false);

  // Chat hook for agentic search (receipt search via worker)
  const { startReceiptSearch, activeWandTargets, notifications } = useChat();
  const isReceiptSearchRunningFromNotification = notifications.some(
    (notification) =>
      notification.type === "worker_activity" &&
      notification.context.workerStatus === "running" &&
      notification.context.transactionId === transaction.id
  );
  const isReceiptSearchRunning =
    activeWandTargets.has(transaction.id) || isReceiptSearchRunningFromNotification;

  // Precision search hook (kept for status tracking)
  const {
    isSearching,
    strategyLabel,
    error: searchError,
  } = usePrecisionSearch({ transactionId: transaction.id });

  // Agentic search trigger - runs receipt search worker
  const triggerSearch = useCallback(() => {
    if (isReceiptSearchRunning) return;
    startReceiptSearch(transaction.id);
  }, [startReceiptSearch, transaction.id, isReceiptSearchRunning]);

  // Operations context for file operations
  const ctx: OperationsContext = useMemo(
    () => ({ db, userId: userId ?? "" }),
    [userId]
  );

  // Calculate SHA-256 hash of file content for duplicate detection
  const calculateFileHash = useCallback(async (file: File): Promise<string> => {
    const buffer = await file.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }, []);

  // Handle file drop - upload and connect to transaction
  const handleFileDrop = useCallback(
    async (acceptedFiles: File[]) => {
      if (acceptedFiles.length === 0) return;

      const file = acceptedFiles[0];
      setUploading(true);
      setUploadError(null);

      try {
        // Calculate hash for duplicate detection
        const contentHash = await calculateFileHash(file);

        // Check for duplicate — if exists, connect existing file instead of re-uploading
        const existingFile = await checkFileDuplicate(ctx, contentHash);
        if (existingFile) {
          await connectFileToTransaction(ctx, existingFile.id, transaction.id, "manual");
        } else {
          // Create storage path
          const timestamp = Date.now();
          const sanitizedName = file.name.replace(/[^a-zA-Z0-9.-]/g, "_");
          const storagePath = `files/${userId}/${timestamp}_${sanitizedName}`;

          // Upload to Firebase Storage
          const storageRef = ref(storage, storagePath);
          const uploadTask = uploadBytesResumable(storageRef, file);

          // Wait for upload to complete
          await new Promise<void>((resolve, reject) => {
            uploadTask.on(
              "state_changed",
              null,
              (err) => reject(err),
              () => resolve()
            );
          });

          // Get download URL
          const downloadUrl = await getDownloadURL(storageRef);

          // Create file record in Firestore
          const fileId = await createFile(ctx, {
            fileName: file.name,
            fileType: file.type,
            fileSize: file.size,
            storagePath,
            downloadUrl,
            contentHash,
          });

          // Connect file to transaction
          await connectFileToTransaction(ctx, fileId, transaction.id, "manual");
        }
      } catch (err) {
        console.error("File upload failed:", err);
        setUploadError(err instanceof Error ? err.message : "Upload failed");
      } finally {
        setUploading(false);
      }
    },
    [ctx, calculateFileHash, transaction.id]
  );

  // Configure dropzone
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop: handleFileDrop,
    accept: ACCEPTED_TYPES,
    maxSize: MAX_FILE_SIZE,
    multiple: false,
    noClick: true,
    noKeyboard: true,
    disabled: uploading,
  });

  return (
    <div {...getRootProps()} className="h-full flex flex-col bg-background overflow-hidden relative">
      <input {...getInputProps()} />

      {/* Drag overlay - matches files page styling */}
      {isDragActive && (
        <div className="absolute inset-0 z-50 bg-primary/10 border-2 border-dashed border-primary flex items-center justify-center pointer-events-none">
          <div className="bg-background rounded-lg p-6 shadow-lg text-center">
            <Upload className="h-12 w-12 mx-auto text-primary mb-2" />
            <p className="text-lg font-medium">Drop file to upload</p>
            <p className="text-sm text-muted-foreground">PDF, JPG, PNG, or WebP up to 10MB</p>
          </div>
        </div>
      )}

      {/* Uploading overlay */}
      {uploading && (
        <div className="absolute inset-0 z-50 bg-background/80 flex items-center justify-center pointer-events-none">
          <div className="bg-background rounded-lg p-6 shadow-lg text-center">
            <Loader2 className="h-8 w-8 animate-spin mx-auto text-primary mb-2" />
            <p className="text-sm font-medium">Uploading...</p>
          </div>
        </div>
      )}

      {/* Upload error toast */}
      {uploadError && (
        <div className="absolute top-4 left-4 right-4 z-50 bg-destructive/10 border border-destructive text-destructive px-4 py-3 rounded-lg flex items-center gap-2">
          <X className="h-4 w-4 flex-shrink-0" />
          <span className="text-sm flex-1">{uploadError}</span>
          <button
            onClick={() => setUploadError(null)}
            className="p-1 hover:bg-destructive/20 rounded"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Header with navigation and close button */}
      <PanelHeader
        title="Transaction Details"
        onClose={onClose}
        onNavigatePrevious={onNavigatePrevious}
        onNavigateNext={onNavigateNext}
        hasPrevious={hasPrevious}
        hasNext={hasNext}
      />

      {/* Scrollable content */}
      <ScrollArea className="flex-1">
        <div className="px-4 py-6 space-y-3">
          {/* Transaction Information */}
          <TransactionDetails
            transaction={transaction}
            source={source}
            userPartners={partners}
            globalPartners={globalPartners}
            onAssignPartner={handleAssignPartner}
            onRemovePartner={handleRemovePartner}
            onCreatePartner={handleCreatePartner}
          />

          {/* Files Section */}
          <SectionDivider />
          <div>
            <TransactionFilesSection
              transaction={transaction}
              isSearching={isSearching || isReceiptSearchRunning}
              searchLabel={strategyLabel}
              onTriggerSearch={triggerSearch}
              onOpenConnectFile={onOpenConnectFile}
              isConnectFileOpen={isConnectFileOpen}
              learnMode={learnMode}
              replayMode={replayMode}
              partnerRecipes={partnerRecipes}
              partnerName={partnerName}
              partnerWebsite={partnerWebsite}
              extensionInstalled={extensionInstalled}
            />
          </div>
        </div>
      </ScrollArea>

      {/* Sticky footer with action buttons */}
      <PanelFooter className="space-y-1">
        {/* Search error message */}
        {searchError && (
          <div className="text-xs text-destructive px-2">
            {searchError}
          </div>
        )}

        {/* Edit History button */}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setShowHistoryPanel(true)}
          className="w-full justify-start gap-2 text-muted-foreground hover:text-foreground"
        >
          <History className="h-4 w-4" />
          <span>Activity Log</span>
        </Button>
      </PanelFooter>

      {/* Full-panel Activity Log overlay */}
      {showHistoryPanel && (
        <div className="absolute inset-0 z-40 bg-background flex flex-col">
          <PanelHeader
            title="Activity Log"
            onClose={() => setShowHistoryPanel(false)}
          />
          <ScrollArea className="flex-1 px-4 py-4">
            <TransactionHistory
              transaction={transaction}
              expandedByDefault
            />
          </ScrollArea>
        </div>
      )}
    </div>
  );
}
