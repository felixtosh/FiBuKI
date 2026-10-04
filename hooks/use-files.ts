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
import { applyFileFilters } from "@/lib/filters/apply-file-filters";
import {
  TaxFile,
  FileFilters,
  FileCreateData,
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
  const deletedOnly = filters?.deletedOnly;
  const search = filters?.search;
  const hasConnections = filters?.hasConnections;
  const copiesOnly = filters?.copiesOnly;
  const extractionComplete = filters?.extractionComplete;
  const documentTypes = filters?.documentTypes;
  const extractedDateFrom = filters?.extractedDateFrom;
  const extractedDateTo = filters?.extractedDateTo;
  const partnerIds = filters?.partnerIds;
  const hasPartner = filters?.hasPartner;
  const amountType = filters?.amountType;

  // Apply filters client-side via useMemo - no loading state change
  const { rows: files, invoiceCount, copies } = useMemo(
    () =>
      applyFileFilters(rawFiles, {
        includeDeleted,
        deletedOnly,
        search,
        hasConnections,
        copiesOnly,
        extractionComplete,
        documentTypes,
        extractedDateFrom,
        extractedDateTo,
        partnerIds,
        hasPartner,
        amountType,
      }),
    [
      rawFiles,
      includeDeleted,
      deletedOnly,
      search,
      hasConnections,
      copiesOnly,
      extractionComplete,
      documentTypes,
      extractedDateFrom,
      extractedDateTo,
      partnerIds,
      hasPartner,
      amountType,
    ],
  );

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

  // Deleting hides the File and `restore` brings it back — for every File,
  // whatever its source. There is no destroying variant to ask for.
  const remove = useCallback(
    async (fileId: string): Promise<{ deletedConnections: number }> => {
      const result = await callFunction<
        { fileId: string },
        { deletedConnections: number }
      >("deleteFile", { fileId });
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

  // Purge destroys deleted Files for good (#268, ADR-0006). One call for the
  // whole selection: the server purges what it may and reports what it
  // refused — generated invoice documents, Files that are not deleted.
  const purge = useCallback(
    async (
      fileIds: string[]
    ): Promise<{
      purged: number;
      alreadyPurged: number;
      refused: Array<{ fileId: string; fileName: string | null; reason: string; message: string }>;
    }> => {
      return callFunction("purgeFiles", { fileIds });
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

  // The Copy acts (#162, ADR-0010). Marking also accepts a Copy suggestion;
  // "Not a Copy" undoes a Copy or declines a suggestion.
  const markAsCopy = useCallback(
    async (fileId: string, originalFileId: string): Promise<void> => {
      await callFunction("markFileAsCopy", { fileId, originalFileId });
    },
    []
  );

  const markNotACopy = useCallback(
    async (fileId: string): Promise<void> => {
      await callFunction("unmarkFileAsCopy", { fileId });
    },
    []
  );

  const makeOriginal = useCallback(
    async (fileId: string): Promise<void> => {
      await callFunction("makeFileTheOriginal", { fileId });
    },
    []
  );

  /** The live Copies of a File: the ones whose original it is. */
  const copiesOf = useCallback(
    (fileId: string): TaxFile[] =>
      rawFiles.filter((f) => copies.get(f.id) === fileId),
    [rawFiles, copies]
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

  const fetchFilesForTransaction = useCallback(
    async (transactionId: string): Promise<TaxFile[]> => {
      // This is a read operation - use the local cached files
      return rawFiles.filter((f) => f.transactionIds.includes(transactionId) && !f.deletedAt);
    },
    [rawFiles]
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
    invoiceCount,
    loading,
    error,
    create,
    update,
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
    fetchFilesForTransaction,
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
  mailMessageId?: string;
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
  // Derived from the account's file list rather than queried per transaction.
  // Every screen that shows files already holds that list as one shared
  // listen, so switching transactions costs no request and the panel never
  // waits on data the table has. Same membership as the query this replaced
  // (`transactionIds` array-contains), and useFiles already leaves deleted
  // files out (soft-deleted files still carry their transactionIds).
  const { files: allFiles, loading, error } = useFiles();
  const files = useMemo(
    () =>
      transactionId
        ? allFiles.filter((file) => file.transactionIds?.includes(transactionId))
        : [],
    [allFiles, transactionId],
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
