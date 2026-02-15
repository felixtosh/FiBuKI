"use client";

import { useState, useEffect, useCallback, useMemo, startTransition } from "react";
import { collection, query, orderBy, onSnapshot, where } from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { callFunction } from "@/lib/firebase/callable";
import {
  TaxFile,
  FileFilters,
  FileCreateData,
  FileExtractionData,
  TransactionMatchSource,
} from "@/types/file";
import { useAuth } from "@/components/auth";

const FILES_COLLECTION = "files";

export function useFiles(filters?: FileFilters) {
  const { userId } = useAuth();
  // Store raw (unfiltered) files from Firestore
  const [rawFiles, setRawFiles] = useState<TaxFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  // Realtime listener for files - only depends on userId, not filters
  useEffect(() => {
    if (!userId) {
      setRawFiles([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    const q = query(
      collection(db, FILES_COLLECTION),
      where("userId", "==", userId),
      orderBy("uploadedAt", "desc")
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const data = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as TaxFile[];

        // Use startTransition to batch updates and prevent flicker
        startTransition(() => {
          setRawFiles(data);
          setLoading(false);
        });
      },
      (err) => {
        console.error("Error fetching files:", err);
        setError(err);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [userId]);

  // Apply filters client-side via useMemo - no loading state change
  const files = useMemo(() => {
    let data = rawFiles;

    // Filter out soft-deleted files by default
    if (!filters?.includeDeleted) {
      data = data.filter((f) => !f.deletedAt);
    }

    // Apply client-side filters
    if (filters?.search) {
      const searchLower = filters.search.toLowerCase();
      data = data.filter(
        (f) =>
          f.fileName.toLowerCase().includes(searchLower) ||
          (f.extractedPartner?.toLowerCase() || "").includes(searchLower)
      );
    }

    if (filters?.hasConnections !== undefined) {
      data = data.filter((f) =>
        filters.hasConnections
          ? f.transactionIds.length > 0
          : f.transactionIds.length === 0
      );
    }

    if (filters?.extractionComplete !== undefined) {
      data = data.filter((f) => f.extractionComplete === filters.extractionComplete);
    }

    // Filter by isNotInvoice status
    if (filters?.isNotInvoice !== undefined) {
      data = data.filter((f) =>
        filters.isNotInvoice ? f.isNotInvoice === true : f.isNotInvoice !== true
      );
    }

    // Filter by extracted date range
    if (filters?.extractedDateFrom || filters?.extractedDateTo) {
      data = data.filter((f) => {
        if (!f.extractedDate) return false;
        const fileDate = f.extractedDate.toDate();
        if (filters.extractedDateFrom && fileDate < filters.extractedDateFrom) return false;
        if (filters.extractedDateTo) {
          // Add 1 day to include the end date fully
          const endDate = new Date(filters.extractedDateTo);
          endDate.setDate(endDate.getDate() + 1);
          if (fileDate >= endDate) return false;
        }
        return true;
      });
    }

    // Filter by partner IDs
    if (filters?.partnerIds && filters.partnerIds.length > 0) {
      const partnerIdSet = new Set(filters.partnerIds);
      data = data.filter((f) => f.partnerId && partnerIdSet.has(f.partnerId));
    }

    // Filter by amount type (income/expense based on invoiceDirection)
    if (filters?.amountType && filters.amountType !== "all") {
      data = data.filter((f) => {
        if (!f.invoiceDirection) return false;
        // incoming = expense (we receive invoice), outgoing = income (we send invoice)
        if (filters.amountType === "expense") return f.invoiceDirection === "incoming";
        if (filters.amountType === "income") return f.invoiceDirection === "outgoing";
        return true;
      });
    }

    return data;
  }, [rawFiles, filters?.search, filters?.hasConnections, filters?.extractionComplete, filters?.includeDeleted, filters?.isNotInvoice, filters?.extractedDateFrom, filters?.extractedDateTo, filters?.partnerIds, filters?.amountType]);

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
  const [files, setFiles] = useState<TaxFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    if (!transactionId || !userId) {
      setFiles([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    // Listen for changes to files that include this transaction
    const q = query(
      collection(db, FILES_COLLECTION),
      where("userId", "==", userId),
      where("transactionIds", "array-contains", transactionId)
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const data = snapshot.docs
          .map((doc) => ({
            id: doc.id,
            ...doc.data(),
          }) as TaxFile)
          // Filter out deleted files (soft-deleted files still have transactionIds)
          .filter((file) => !file.deletedAt);

        // Use startTransition to batch updates and prevent flicker
        startTransition(() => {
          setFiles(data);
          setLoading(false);
        });
      },
      (err) => {
        console.error("Error fetching transaction files:", err);
        setError(err);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [transactionId, userId]);

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
