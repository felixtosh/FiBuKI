"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
  limit,
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { db, storage } from "@/lib/firebase/config";
import { callFunction } from "@/lib/firebase/callable";
import { useAuth } from "@/components/auth";
import {
  UserImport,
  ImportValidation,
  ValidateUserImportRequest,
  ExecuteUserImportRequest,
  ExecuteUserImportResponse,
} from "@/types/user-export";

export function useUserImport() {
  const { userId } = useAuth();
  const [imports, setImports] = useState<UserImport[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [uploading, setUploading] = useState(false);
  const [validating, setValidating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [validation, setValidation] = useState<ImportValidation | null>(null);
  const [currentImportId, setCurrentImportId] = useState<string | null>(null);
  const [uploadPath, setUploadPath] = useState<string | null>(null);

  // Get current active import (non-completed)
  const activeImport = useMemo(
    () =>
      imports.find(
        (i) =>
          i.status === "pending" ||
          i.status === "validating" ||
          i.status === "wiping" ||
          i.status === "importing"
      ),
    [imports]
  );

  // Real-time listener for imports
  useEffect(() => {
    if (!userId) {
      setImports([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    const q = query(
      collection(db, "userImports"),
      where("userId", "==", userId),
      orderBy("createdAt", "desc"),
      limit(5)
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const data = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as UserImport[];

        setImports(data);
        setLoading(false);
      },
      (err) => {
        console.error("Error fetching imports:", err);
        setError(err);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [userId]);

  // Upload ZIP file and validate
  const uploadAndValidate = useCallback(
    async (file: File): Promise<boolean> => {
      if (!userId) return false;

      setError(null);
      setValidation(null);
      setUploading(true);

      try {
        // Generate unique path
        const timestamp = Date.now();
        const path = `user-imports/${userId}/${timestamp}/upload.zip`;
        const storageRef = ref(storage, path);

        // Upload file
        await uploadBytes(storageRef, file, {
          contentType: "application/zip",
          customMetadata: {
            userId,
            fileName: file.name,
          },
        });

        setUploadPath(path);
        setUploading(false);
        setValidating(true);

        // Validate the uploaded file
        const result = await callFunction<ValidateUserImportRequest, ImportValidation>(
          "validateUserImport",
          { uploadPath: path }
        );

        setValidation(result);

        // If validation created an import record, capture the ID
        if ((result as any).importId) {
          setCurrentImportId((result as any).importId);
        }

        return result.valid;
      } catch (err) {
        const error = err instanceof Error ? err : new Error("Upload failed");
        setError(error);
        return false;
      } finally {
        setUploading(false);
        setValidating(false);
      }
    },
    [userId]
  );

  // Execute the import
  const executeImport = useCallback(async (): Promise<boolean> => {
    if (!currentImportId && !uploadPath) {
      setError(new Error("No import to execute"));
      return false;
    }

    setError(null);
    setImporting(true);

    try {
      const result = await callFunction<ExecuteUserImportRequest, ExecuteUserImportResponse>(
        "executeUserImport",
        {
          importId: currentImportId || "",
          confirmWipe: true,
        }
      );

      if (result.success) {
        // Clear local state - real-time listener will pick up the import progress
        setValidation(null);
        setCurrentImportId(null);
        setUploadPath(null);
        return true;
      } else {
        setError(new Error(result.error || "Import failed"));
        return false;
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Import failed");
      setError(error);
      return false;
    } finally {
      setImporting(false);
    }
  }, [currentImportId, uploadPath]);

  // Cancel/reset the import process
  const cancelImport = useCallback(() => {
    setValidation(null);
    setCurrentImportId(null);
    setUploadPath(null);
    setError(null);
  }, []);

  // Format file size
  const formatSize = useCallback((bytes?: number): string => {
    if (!bytes) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let unitIndex = 0;
    let size = bytes;
    while (size >= 1024 && unitIndex < units.length - 1) {
      size /= 1024;
      unitIndex++;
    }
    return `${size.toFixed(1)} ${units[unitIndex]}`;
  }, []);

  return {
    imports,
    activeImport,
    validation,
    loading,
    error,
    uploading,
    validating,
    importing,
    uploadAndValidate,
    executeImport,
    cancelImport,
    formatSize,
  };
}
