import { useEffect, useRef, useState } from "react";
import { fetchWithAuth } from "@/lib/api/fetch-with-auth";

interface AttachmentParams {
  integrationId: string;
  messageId: string;
  attachmentId: string;
  mimeType: string;
  filename: string;
}

interface UseAttachmentPreviewResult {
  blobUrl: string | null;
  isLoading: boolean;
  error: string | null;
}

/**
 * Hook to fetch an attachment with authentication and create a blob URL for preview.
 * This is necessary because direct browser requests (iframe, img src) don't include
 * the Authorization header.
 */
export function useAttachmentPreview(
  params: AttachmentParams | null,
): UseAttachmentPreviewResult {
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const previousParamsRef = useRef<string | null>(null);
  const blobUrlRef = useRef<string | null>(null);

  // Keep blobUrlRef in sync so cleanup can revoke without taking blobUrl as
  // an effect dep (which would tear down the fetch effect on every load).
  useEffect(() => {
    blobUrlRef.current = blobUrl;
  }, [blobUrl]);

  useEffect(() => {
    if (!params) {
      previousParamsRef.current = null;
      return;
    }

    const paramsKey = `${params.integrationId}-${params.messageId}-${params.attachmentId}`;

    if (previousParamsRef.current === paramsKey && blobUrlRef.current) {
      return;
    }
    previousParamsRef.current = paramsKey;

    let cancelled = false;

    const fetchAttachment = async () => {
      const previousBlobUrl = blobUrlRef.current;

      if (previousBlobUrl) {
        URL.revokeObjectURL(previousBlobUrl);
      }

      if (cancelled) return;
      setIsLoading(true);
      setError(null);
      setBlobUrl(null);

      try {
        const searchParams = new URLSearchParams({
          integrationId: params.integrationId,
          messageId: params.messageId,
          attachmentId: params.attachmentId,
          mimeType: params.mimeType,
          filename: params.filename,
        });

        const response = await fetchWithAuth(
          `/api/gmail/attachment?${searchParams.toString()}`,
          { method: "GET" },
        );

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(
            errorData.error || `Failed to load attachment: ${response.status}`,
          );
        }

        const blob = await response.blob();
        const url = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(url);
          return;
        }
        setBlobUrl(url);
      } catch (err) {
        if (cancelled) return;
        console.error("Error fetching attachment:", err);
        setError(
          err instanceof Error ? err.message : "Failed to load attachment",
        );
        setBlobUrl(null);
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    };

    void fetchAttachment();

    return () => {
      cancelled = true;
    };
  }, [
    params?.integrationId,
    params?.messageId,
    params?.attachmentId,
    params?.mimeType,
    params?.filename,
    params,
  ]);

  // Final cleanup: revoke any outstanding blob URL when the hook unmounts.
  useEffect(() => {
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
      }
    };
  }, []);

  return { blobUrl, isLoading, error };
}

/**
 * Fetch an attachment as a blob URL (one-time fetch, not reactive).
 */
export async function fetchAttachmentBlobUrl(
  params: AttachmentParams,
): Promise<string> {
  const searchParams = new URLSearchParams({
    integrationId: params.integrationId,
    messageId: params.messageId,
    attachmentId: params.attachmentId,
    mimeType: params.mimeType,
    filename: params.filename,
  });

  const response = await fetchWithAuth(
    `/api/gmail/attachment?${searchParams.toString()}`,
    { method: "GET" },
  );

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(
      errorData.error || `Failed to load attachment: ${response.status}`,
    );
  }

  const blob = await response.blob();
  return URL.createObjectURL(blob);
}
