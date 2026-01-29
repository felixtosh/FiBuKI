"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { httpsCallable } from "firebase/functions";
import { functions, db } from "@/lib/firebase/config";
import { useAuth } from "@/components/auth";
import {
  OperationsContext,
  subscribePasskeys,
} from "@/lib/operations";
import { PasskeyCredential } from "@/types/mfa";
import {
  startRegistration,
  startAuthentication,
} from "@simplewebauthn/browser";
import type {
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/types";

export function usePasskeys() {
  const { userId } = useAuth();
  const [passkeys, setPasskeys] = useState<PasskeyCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  // Create operations context
  const ctx: OperationsContext = useMemo(
    () => ({
      db,
      userId: userId ?? "",
    }),
    [userId]
  );

  // Real-time listener for passkeys
  useEffect(() => {
    if (!userId) {
      setPasskeys([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    const unsubscribe = subscribePasskeys(ctx, (passkeyList) => {
      setPasskeys(passkeyList);
      setLoading(false);
    });

    return () => unsubscribe();
  }, [userId, ctx]);

  // Check if WebAuthn is supported
  const isSupported = useMemo(() => {
    if (typeof window === "undefined") return false;
    return (
      window.PublicKeyCredential !== undefined &&
      typeof window.PublicKeyCredential === "function"
    );
  }, []);

  // Check if platform authenticator is available (Touch ID, Face ID, Windows Hello)
  const checkPlatformAuthenticator = useCallback(async (): Promise<boolean> => {
    if (!isSupported) return false;
    try {
      return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
    } catch {
      return false;
    }
  }, [isSupported]);

  // Register a new passkey
  const registerPasskey = useCallback(
    async (deviceName?: string): Promise<string> => {
      if (!isSupported) {
        throw new Error("WebAuthn is not supported in this browser");
      }

      setActionLoading(true);
      setError(null);

      try {
        // Get registration options from server (pass current origin for RP ID selection)
        const getOptionsFn = httpsCallable<
          { origin: string },
          PublicKeyCredentialCreationOptionsJSON
        >(functions, "generatePasskeyRegistrationOptions");
        const optionsResult = await getOptionsFn({ origin: window.location.origin });
        const options = optionsResult.data;

        // Trigger WebAuthn registration
        const credential = await startRegistration({ optionsJSON: options });

        // Verify with server and store
        const verifyFn = httpsCallable<
          { credential: typeof credential; deviceName?: string },
          { success: boolean; credentialId: string }
        >(functions, "verifyPasskeyRegistration");
        const verifyResult = await verifyFn({
          credential,
          deviceName: deviceName || "Security Key",
        });

        return verifyResult.data.credentialId;
      } catch (err) {
        // Handle specific WebAuthn errors
        if (err instanceof Error) {
          if (err.name === "NotAllowedError") {
            throw new Error("Passkey registration was cancelled or timed out");
          }
          if (err.name === "InvalidStateError") {
            throw new Error("This passkey is already registered");
          }
        }
        const error = err instanceof Error ? err : new Error("Failed to register passkey");
        setError(error);
        throw error;
      } finally {
        setActionLoading(false);
      }
    },
    [isSupported]
  );

  // Authenticate with a passkey
  const authenticateWithPasskey = useCallback(async (): Promise<boolean> => {
    if (!isSupported) {
      throw new Error("WebAuthn is not supported in this browser");
    }

    setActionLoading(true);
    setError(null);

    try {
      // Get authentication options from server (pass current origin for RP ID selection)
      const getOptionsFn = httpsCallable<
        { origin: string },
        PublicKeyCredentialRequestOptionsJSON
      >(functions, "generatePasskeyAuthOptions");
      const optionsResult = await getOptionsFn({ origin: window.location.origin });
      const options = optionsResult.data;

      // Trigger WebAuthn authentication
      const credential = await startAuthentication({ optionsJSON: options });

      // Verify with server
      const verifyFn = httpsCallable<
        { credential: typeof credential },
        { success: boolean }
      >(functions, "verifyPasskeyAuth");
      const verifyResult = await verifyFn({ credential });

      return verifyResult.data.success;
    } catch (err) {
      // Handle specific WebAuthn errors
      if (err instanceof Error) {
        if (err.name === "NotAllowedError") {
          throw new Error("Passkey authentication was cancelled or timed out");
        }
      }
      const error = err instanceof Error ? err : new Error("Failed to authenticate with passkey");
      setError(error);
      throw error;
    } finally {
      setActionLoading(false);
    }
  }, [isSupported]);

  // Delete a passkey
  const deletePasskey = useCallback(async (credentialId: string): Promise<void> => {
    setActionLoading(true);
    setError(null);

    try {
      const fn = httpsCallable<{ credentialId: string }, { success: boolean }>(
        functions,
        "deletePasskey"
      );
      await fn({ credentialId });
    } catch (err) {
      const error = err instanceof Error ? err : new Error("Failed to delete passkey");
      setError(error);
      throw error;
    } finally {
      setActionLoading(false);
    }
  }, []);

  return {
    // State
    passkeys,
    loading,
    error,
    actionLoading,

    // Computed
    isSupported,
    hasPasskeys: passkeys.length > 0,
    passkeyCount: passkeys.length,

    // Actions
    checkPlatformAuthenticator,
    registerPasskey,
    authenticateWithPasskey,
    deletePasskey,
  };
}
