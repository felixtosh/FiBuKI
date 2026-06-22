"use client";

import { useCallback, useMemo } from "react";
import {
  collection,
  orderBy,
  query,
  where,
  type QueryDocumentSnapshot,
} from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { callFunction } from "@/lib/firebase/callable";
import { useFirestoreCollection } from "@/lib/firebase/use-firestore-collection";
import {
  TaxFile,
  FileFilters,
  FileCreateData,
  FileExtractionData,
  TransactionMatchSource,
} from "@/types/file";
import { useAuth } from "@/components/auth";

const FILES_COLLECTION = "files";

function mapFile(doc: QueryDocumentSnapshot): TaxFile {
  return { id: doc.id, ...doc.data() } as TaxFile;
}

export function useFiles(filters?: FileFilters) {
  const { userId } = useAuth();

  const q = useMemo(
    () =>
      userId
        ? query(
            collection(db, FILES_COLLECTION),
            where("userId", "==", userId),
            orderBy("uploadedAt", "desc"),
          )
        : null,
    [userId],
  );

  const { data: rawFiles, loading, error } = useFirestoreCollection(q, mapFile);

  const includeDeleted = filters?.includeDeleted;
  const search = filters?.search;
  const hasConnections = filters?.hasConnections;
  const extractionComplete = filters?.extractionComplete;
  const isNotInvoice = filters?.isNotInvoice;
  const extractedDateFrom = filters?.extractedDateFrom;
  const extractedDateTo = filters?.extractedDateTo;
  const partnerIds = filters?.partnerIds;
  const amountType = filters?.amountType;

  // Apply filters client-side via useMemo - no loading state change
  const files = useMemo(() => {
    let data = rawFiles;

    if (!includeDeleted) {
      data = data.filter((f) => !f.deletedAt);
    }

    if (search) {
      const searchLower = search.toLowerCase();
      data = data.filter(
        (f) =>
          f.fileName.toLowerCase().includes(searchLower) ||
          (f.extractedPartner?.toLowerCase() || "").includes(searchLower),
      );
    }

    if (hasConnections !== undefined) {
      data = data.filter((f) =>
        hasConnections
          ? f.transactionIds.length > 0
          : f.transactionIds.length === 0,
      );
    }

    if (extractionComplete !== undefined) {
      data = data.filter((f) => f.extractionComplete === extractionComplete);
    }

    if (isNotInvoice !== undefined) {
      data = data.filter((f) =>
        isNotInvoice ? f.isNotInvoice === true : f.isNotInvoice !== true,
      );
    }

    if (extractedDateFrom || extractedDateTo) {
      data = data.filter((f) => {
        if (!f.extractedDate) return false;
        const fileDate = f.extractedDate.toDate();
        if (extractedDateFrom && fileDate < extractedDateFrom) return false;
        if (extractedDateTo) {
          // Add 1 day to include the end date fully
          const endDate = new Date(extractedDateTo);
          endDate.setDate(endDate.getDate() + 1);
          if (fileDate >= endDate) return false;
        }
        return true;
      });
    }

    if (partnerIds && partnerIds.length > 0) {
      const partnerIdSet = new Set(partnerIds);
      data = data.filter((f) => f.partnerId && partnerIdSet.has(f.partnerId));
    }

    if (amountType && amountType !== "all") {
      data = data.filter((f) => {
        if (!f.invoiceDirection) return false;
        if (amountType === "expense") return f.invoiceDirection === "incoming";
        if (amountType === "income") return f.invoiceDirection === "outgoing";
        return true;
      });
    }

    return data;
  }, [
    rawFiles,
    includeDeleted,
    search,
    hasConnections,
    extractionComplete,
    isNotInvoice,
    extractedDateFrom,
    extractedDateTo,
    partnerIds,
    amountType,
  ]);

  // Mutations call Cloud Functions
  const create = useCallback(
    async (data: FileCreateData): Promise<string> => {
      const result = await callFunction<{ data: FileCreateData }, { fileId: string }>(
        "createFile",
        { data }
      );
      return result.fileId;
    },
    []
  );

  const update = useCallback(
    async (fileId: string, data: Partial<Pick<TaxFile, "fileName" | "thumbnailUrl">>): Promise<void> => {
      await callFunction("updateFile", { fileId, data });
    },
    []
  );

  const updateExtraction = useCallback(
    async (fileId: string, data: FileExtractionData): Promise<void> => {
      // Convert FileExtractionData to updateFile format
      const updateData: Record<string, unknown> = {};
      if (data.extractedDate) {
        updateData.extractedDate = data.extractedDate.toDate().toISOString();
      }
      if (data.extractedAmount !== undefined) updateData.extractedAmount = data.extractedAmount;
      if (data.extractedPartner !== undefined) updateData.extractedPartner = data.extractedPartner;
      if (data.extractedVatPercent !== undefined) updateData.extractedVatPercent = data.extractedVatPercent;
      if (data.extractedVatAmount !== undefined) updateData.extractedVatAmount = data.extractedVatAmount;
      if (data.extractedLineItems !== undefined) updateData.extractedLineItems = data.extractedLineItems;
      if (data.extractedVatId !== undefined) updateData.extractedVatId = data.extractedVatId;
      if (data.extractedIban !== undefined) updateData.extractedIban = data.extractedIban;
      if (data.extractedAddress !== undefined) updateData.extractedAddress = data.extractedAddress;

      await callFunction("updateFile", { fileId, data: updateData });
    },
    []
  );

  const remove = useCallback(
    async (fileId: string, soft = false): Promise<{ deletedConnections: number }> => {
      const result = await callFunction<
        { fileId: string; hardDelete?: boolean },
        { deletedConnections: number }
      >("deleteFile", { fileId, hardDelete: !soft });
      return { deletedConnections: result.deletedConnections };
    },
    []
  );

  const restore = useCallback(
    async (fileId: string): Promise<void> => {
      await callFunction("restoreFile", { fileId });
    },
    []
  );

  const markAsNotInvoice = useCallback(
    async (fileId: string, reason?: string): Promise<void> => {
      await callFunction("markFileAsNotInvoice", { fileId, reason });
    },
    []
  );

  const unmarkAsNotInvoice = useCallback(
    async (fileId: string): Promise<void> => {
      await callFunction("unmarkFileAsNotInvoice", { fileId });
    },
    []
  );

  const getFileById = useCallback(
    (fileId: string): TaxFile | undefined => {
      // Search all files, not just filtered ones
      return rawFiles.find((f) => f.id === fileId);
    },
    [rawFiles]
  );

  // Total count of files (excluding soft-deleted) for empty state logic
  const allFilesCount = useMemo(() => {
    return rawFiles.filter((f) => !f.deletedAt).length;
  }, [rawFiles]);

  const connectToTransaction = useCallback(
    async (
      fileId: string,
      transactionId: string,
      connectionType: "manual" | "auto_matched" = "manual",
      matchConfidence?: number
    ): Promise<string> => {
      const result = await callFunction<
        {
          fileId: string;
          transactionId: string;
          connectionType?: "manual" | "auto_matched";
          matchConfidence?: number;
        },
        { connectionId: string }
      >("connectFileToTransaction", {
        fileId,
        transactionId,
        connectionType,
        matchConfidence,
      });
      return result.connectionId;
    },
    []
  );

  const disconnectFromTransaction = useCallback(
    async (fileId: string, transactionId: string): Promise<void> => {
      await callFunction("disconnectFileFromTransaction", { fileId, transactionId });
    },
    []
  );

  const fetchFilesForTransaction = useCallback(
    async (transactionId: string): Promise<TaxFile[]> => {
      // This is a read operation - use the local cached files
      return rawFiles.filter((f) => f.transactionIds.includes(transactionId) && !f.deletedAt);
    },
    [rawFiles]
  );

  const acceptSuggestion = useCallback(
    async (
      fileId: string,
      transactionId: string,
      confidence: number,
      matchSources: TransactionMatchSource[]
    ): Promise<string> => {
      // Accept suggestion by connecting the file to the transaction
      const result = await callFunction<
        {
          fileId: string;
          transactionId: string;
          connectionType: "auto_matched";
          matchConfidence: number;
        },
        { connectionId: string }
      >("connectFileToTransaction", {
        fileId,
        transactionId,
        connectionType: "auto_matched",
        matchConfidence: confidence,
      });
      return result.connectionId;
    },
    []
  );

  const dismissSuggestion = useCallback(
    async (fileId: string, transactionId: string): Promise<void> => {
      await callFunction("dismissTransactionSuggestion", { fileId, transactionId });
    },
    []
  );

  return {
    files,
    allFilesCount,
    loading,
    error,
    create,
    update,
    updateExtraction,
    remove,
    restore,
    markAsNotInvoice,
    unmarkAsNotInvoice,
    getFileById,
    connectToTransaction,
    disconnectFromTransaction,
    fetchFilesForTransaction,
    acceptSuggestion,
    dismissSuggestion,
  };
}

/**
 * Source info for tracking how a file was found when connecting
 */
export interface FileConnectionSourceInfo {
  /** Where the file was found */
  sourceType: string;
  /** The search pattern/query used */
  searchPattern?: string;
  /** For Gmail: which integration (account) */
  gmailIntegrationId?: string;
  /** For Gmail: integration email */
  gmailIntegrationEmail?: string;
  /** For Gmail: message ID */
  gmailMessageId?: string;
  /** For Gmail: sender email */
  gmailMessageFrom?: string;
  /** For Gmail: sender name */
  gmailMessageFromName?: string;
  /** Type of result selected during the connection */
  resultType?: string;
}

/**
 * Hook to get files for a specific transaction with realtime updates
 */
export function useTransactionFiles(transactionId: string | null) {
  const { userId } = useAuth();

  const q = useMemo(
    () =>
      transactionId && userId
        ? query(
            collection(db, FILES_COLLECTION),
            where("userId", "==", userId),
            where("transactionIds", "array-contains", transactionId),
          )
        : null,
    [transactionId, userId],
  );

  const { data: rawFiles, loading, error } = useFirestoreCollection(q, mapFile);

  // Filter out deleted files (soft-deleted files still have transactionIds)
  const files = useMemo(
    () => rawFiles.filter((file) => !file.deletedAt),
    [rawFiles],
  );

  const connectFile = useCallback(
    async (fileId: string, sourceInfo?: FileConnectionSourceInfo): Promise<string> => {
      if (!transactionId) throw new Error("No transaction selected");
      const result = await callFunction<
        {
          fileId: string;
          transactionId: string;
          connectionType: "manual";
          sourceInfo?: FileConnectionSourceInfo;
        },
        { connectionId: string }
      >("connectFileToTransaction", {
        fileId,
        transactionId,
        connectionType: "manual",
        sourceInfo,
      });
      return result.connectionId;
    },
    [transactionId]
  );

  const disconnectFile = useCallback(
    async (fileId: string, reject: boolean = false): Promise<void> => {
      if (!transactionId) throw new Error("No transaction selected");
      await callFunction("disconnectFileFromTransaction", {
        fileId,
        transactionId,
        rejectFile: reject,
      });
    },
    [transactionId]
  );

  const unrejectFile = useCallback(
    async (fileId: string): Promise<void> => {
      if (!transactionId) throw new Error("No transaction selected");
      await callFunction("unrejectFileFromTransaction", { fileId, transactionId });
    },
    [transactionId]
  );

  return {
    files,
    loading,
    error,
    connectFile,
    disconnectFile,
    unrejectFile,
  };
}
