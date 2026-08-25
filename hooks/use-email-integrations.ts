"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import {
  collection,
  query,
  where,
  orderBy,
  onSnapshot,
} from "firebase/firestore";
import { db } from "@/lib/firebase/config";
import { EmailIntegration } from "@/types/email-integration";
import { useAuth } from "@/components/auth";
import { fetchWithAuth } from "@/lib/api/fetch-with-auth";

const INTEGRATIONS_COLLECTION = "emailIntegrations";

export interface ImapConnectParams {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  mailbox?: string;
  allowSelfSigned?: boolean;
  keywordPrefilter?: boolean;
}

export interface ImapRepairParams {
  integrationId: string;
  /** The new app-password. Everything else is optional and means "keep". */
  password: string;
  host?: string;
  port?: number;
  secure?: boolean;
  mailbox?: string;
  allowSelfSigned?: boolean;
}

export interface UseEmailIntegrationsResult {
  /** List of connected email integrations */
  integrations: EmailIntegration[];
  /** Loading state */
  loading: boolean;
  /** Error message if any */
  error: string | null;
  /** Connect a new Gmail account */
  connectGmail: () => Promise<void>;
  /** Connect a mailbox over IMAP (verifies + persists server-side) */
  connectImap: (params: ImapConnectParams) => Promise<void>;
  /** Repair a connected IMAP mailbox in place with a new app-password */
  repairImapCredentials: (params: ImapRepairParams) => Promise<void>;
  /** Disconnect an integration */
  disconnect: (integrationId: string) => Promise<void>;
  /** Refresh an integration (reconnect OAuth) */
  refresh: (integrationId: string, returnTo?: string) => Promise<void>;
  /** Pause sync for an integration */
  pauseSync: (integrationId: string) => Promise<void>;
  /** Resume sync for an integration */
  resumeSync: (integrationId: string) => Promise<void>;
  /** Check if any Gmail integration is connected */
  hasGmailIntegration: boolean;
}

export function useEmailIntegrations(): UseEmailIntegrationsResult {
  const { userId } = useAuth();
  const [integrations, setIntegrations] = useState<EmailIntegration[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Subscribe to integrations
  useEffect(() => {
    if (!userId) {
      setIntegrations([]);
      setLoading(false);
      return;
    }

    const q = query(
      collection(db, INTEGRATIONS_COLLECTION),
      where("userId", "==", userId),
      where("isActive", "==", true),
      orderBy("createdAt", "desc")
    );

    const unsubscribe = onSnapshot(
      q,
      (snapshot) => {
        const items = snapshot.docs.map((doc) => ({
          id: doc.id,
          ...doc.data(),
        })) as EmailIntegration[];
        setIntegrations(items);
        setLoading(false);
        setError(null);
      },
      (err) => {
        console.error("Error listening to integrations:", err);
        setError(err.message);
        setLoading(false);
      }
    );

    return () => unsubscribe();
  }, [userId]);

  // Connect Gmail account - redirects to OAuth flow
  const connectGmail = useCallback(async () => {
    if (!userId) {
      setError("You must be logged in to connect Gmail");
      return;
    }
    try {
      setError(null);
      // Start OAuth via an authenticated call. The server derives the user from
      // the verified token and returns the Google consent URL to navigate to.
      const res = await fetchWithAuth("/api/gmail/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to start Gmail authorization");
      }
      const { url } = await res.json();
      window.location.href = url;
    } catch (err) {
      console.error("Failed to connect Gmail:", err);
      const message = err instanceof Error ? err.message : "Failed to connect Gmail";
      setError(message);
      throw err;
    }
  }, [userId]);

  // Connect a mailbox over IMAP. The route verifies with a live login before
  // persisting, so a rejected promise means the mailbox was NOT connected.
  const connectImap = useCallback(async (params: ImapConnectParams) => {
    if (!userId) {
      setError("You must be logged in to connect a mailbox");
      throw new Error("Not authenticated");
    }
    try {
      setError(null);
      const response = await fetchWithAuth("/api/mail/imap/connect", {
        method: "POST",
        body: JSON.stringify(params),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to connect mailbox");
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to connect mailbox";
      setError(message);
      throw err;
    }
  }, [userId]);

  // Repair a broken mailbox in place. Unlike disconnect-then-connect, this
  // keeps the integration document, its files, and its sync history: the route
  // verifies the new app-password with a live login before storing it, so a
  // rejected promise means nothing about the mailbox changed.
  const repairImapCredentials = useCallback(async (params: ImapRepairParams) => {
    try {
      setError(null);
      const response = await fetchWithAuth("/api/mail/imap/credentials", {
        method: "PATCH",
        body: JSON.stringify(params),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || "Failed to update credentials");
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to update credentials";
      setError(message);
      throw err;
    }
  }, []);

  // Disconnect integration
  const disconnect = useCallback(async (integrationId: string) => {
    try {
      setError(null);

      const response = await fetchWithAuth(
        `/api/gmail/disconnect?integrationId=${encodeURIComponent(integrationId)}`,
        { method: "DELETE" }
      );

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to disconnect");
      }
    } catch (err) {
      console.error("Failed to disconnect:", err);
      const message = err instanceof Error ? err.message : "Failed to disconnect";
      setError(message);
      throw err;
    }
  }, []);

  // Refresh integration (reconnect OAuth)
  const refresh = useCallback(
    async (integrationId: string, returnTo?: string) => {
      if (!userId) {
        setError("You must be logged in to refresh integration");
        return;
      }
      // Find the integration to get the email
      const integration = integrations.find((i) => i.id === integrationId);
      if (!integration) {
        throw new Error("Integration not found");
      }

      // Reconnect via an authenticated call; user derived from verified token.
      const res = await fetchWithAuth("/api/gmail/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(returnTo ? { returnTo } : {}),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || "Failed to start Gmail authorization");
      }
      const { url } = await res.json();
      window.location.href = url;
    },
    [integrations, userId]
  );

  // Pause sync for an integration
  const pauseSync = useCallback(async (integrationId: string) => {
    try {
      setError(null);

      const response = await fetchWithAuth("/api/gmail/pause", {
        method: "POST",
        body: JSON.stringify({ integrationId }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to pause sync");
      }
    } catch (err) {
      console.error("Failed to pause sync:", err);
      const message = err instanceof Error ? err.message : "Failed to pause sync";
      setError(message);
      throw err;
    }
  }, []);

  // Resume sync for an integration
  const resumeSync = useCallback(async (integrationId: string) => {
    try {
      setError(null);

      const response = await fetchWithAuth("/api/gmail/resume", {
        method: "POST",
        body: JSON.stringify({ integrationId }),
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || "Failed to resume sync");
      }
    } catch (err) {
      console.error("Failed to resume sync:", err);
      const message = err instanceof Error ? err.message : "Failed to resume sync";
      setError(message);
      throw err;
    }
  }, []);

  // Check if any Gmail integration exists
  const hasGmailIntegration = useMemo(
    () => integrations.some((i) => i.provider === "gmail"),
    [integrations]
  );

  return {
    integrations,
    loading,
    error,
    connectGmail,
    connectImap,
    repairImapCredentials,
    disconnect,
    refresh,
    pauseSync,
    resumeSync,
    hasGmailIntegration,
  };
}
