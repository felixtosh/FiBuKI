"use client";

import { useState, useCallback } from "react";
import {
  MultiFactorError,
  MultiFactorResolver,
  getMultiFactorResolver,
  TotpMultiFactorGenerator,
  PhoneMultiFactorGenerator,
  MultiFactorInfo,
} from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { auth, functions } from "@/lib/firebase/config";
import {
  startAuthentication,
} from "@simplewebauthn/browser";
import type { PublicKeyCredentialRequestOptionsJSON } from "@simplewebauthn/types";
import type { MfaStatusResponse } from "@/types/mfa";

export type MfaChallengeMethod = "totp" | "passkey" | "backup_code";

export interface MfaChallengeState {
  isRequired: boolean;
  resolver: MultiFactorResolver | null;
  availableMethods: MfaChallengeMethod[];
  selectedMethod: MfaChallengeMethod | null;
  enrolledFactors: MultiFactorInfo[];
}

export function useMfaChallenge() {
  const [state, setState] = useState<MfaChallengeState>({
    isRequired: false,
    resolver: null,
    availableMethods: [],
    selectedMethod: null,
    enrolledFactors: [],
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Handle MFA required error from Firebase Auth
  const handleMfaRequired = useCallback(
    (authError: MultiFactorError, hasPasskeys: boolean = false) => {
      try {
        const resolver = getMultiFactorResolver(auth, authError);
        const enrolledFactors = resolver.hints;

        // Determine available methods
        const methods: MfaChallengeMethod[] = [];

        // Check for TOTP
        const hasTotp = enrolledFactors.some(
          (factor) => factor.factorId === TotpMultiFactorGenerator.FACTOR_ID
        );
        if (hasTotp) {
          methods.push("totp");
        }

        // Check for passkeys (WebAuthn - not part of Firebase MFA, but we support it)
        if (hasPasskeys) {
          methods.push("passkey");
        }

        // Backup codes are always available if user has MFA
        methods.push("backup_code");

        setState({
          isRequired: true,
          resolver,
          availableMethods: methods,
          selectedMethod: methods[0] || null,
          enrolledFactors,
        });

        setError(null);
      } catch (err) {
        console.error("Error handling MFA requirement:", err);
        setError("Failed to initialize MFA challenge");
      }
    },
    []
  );

  // Handle custom MFA required (for passkey-only users who bypassed Firebase MFA)
  const handleCustomMfaRequired = useCallback(
    (mfaStatus: MfaStatusResponse) => {
      // Determine available methods based on what the user has set up
      const methods: MfaChallengeMethod[] = [];

      // Passkeys are available (this is why we're here)
      if (mfaStatus.passkeysEnabled) {
        methods.push("passkey");
      }

      // TOTP if enabled (shouldn't be for passkey-only users, but include for completeness)
      if (mfaStatus.totpEnabled) {
        methods.push("totp");
      }

      // Backup codes if available
      if (mfaStatus.backupCodesRemaining > 0) {
        methods.push("backup_code");
      }

      // Determine the default method based on lastMfaMethod preference
      let selectedMethod = methods[0] || null;
      if (mfaStatus.lastMfaMethod && methods.includes(mfaStatus.lastMfaMethod)) {
        selectedMethod = mfaStatus.lastMfaMethod;
      }

      setState({
        isRequired: true,
        resolver: null, // No Firebase resolver for custom MFA
        availableMethods: methods,
        selectedMethod,
        enrolledFactors: [],
      });

      setError(null);
    },
    []
  );

  // Select an MFA method
  const selectMethod = useCallback((method: MfaChallengeMethod) => {
    setState((prev) => ({ ...prev, selectedMethod: method }));
    setError(null);
  }, []);

  // Verify TOTP code
  const verifyTotp = useCallback(
    async (code: string): Promise<void> => {
      if (!state.resolver) {
        throw new Error("No MFA resolver available");
      }

      setLoading(true);
      setError(null);

      try {
        // Find the TOTP factor hint
        const totpHint = state.enrolledFactors.find(
          (factor) => factor.factorId === TotpMultiFactorGenerator.FACTOR_ID
        );

        if (!totpHint) {
          throw new Error("TOTP not enrolled");
        }

        // Generate assertion
        const assertion = TotpMultiFactorGenerator.assertionForSignIn(
          totpHint.uid,
          code
        );

        // Complete sign-in
        await state.resolver.resolveSignIn(assertion);

        // Clear state on success
        setState({
          isRequired: false,
          resolver: null,
          availableMethods: [],
          selectedMethod: null,
          enrolledFactors: [],
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Invalid verification code";
        setError(message);
        throw err;
      } finally {
        setLoading(false);
      }
    },
    [state.resolver, state.enrolledFactors]
  );

  // Verify passkey
  const verifyPasskey = useCallback(async (): Promise<void> => {
    setLoading(true);
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
      const result = await verifyFn({ credential });

      if (!result.data.success) {
        throw new Error("Passkey verification failed");
      }

      // For passkey MFA, we don't use Firebase's resolver
      // The passkey verification on our server is sufficient
      // The client should proceed with the sign-in flow

      // Clear state on success
      setState({
        isRequired: false,
        resolver: null,
        availableMethods: [],
        selectedMethod: null,
        enrolledFactors: [],
      });
    } catch (err) {
      // Handle user cancellation gracefully
      const errorName = err instanceof Error ? err.name : "";
      let message: string;

      if (errorName === "NotAllowedError" || errorName === "AbortError") {
        // User cancelled the WebAuthn prompt
        message = "Verification was cancelled. Please try again.";
      } else {
        message = err instanceof Error ? err.message : "Passkey verification failed";
      }

      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  // Verify backup code
  const verifyBackupCode = useCallback(async (code: string): Promise<void> => {
    setLoading(true);
    setError(null);

    try {
      const fn = httpsCallable<{ code: string }, { success: boolean }>(
        functions,
        "verifyBackupCode"
      );
      const result = await fn({ code });

      if (!result.data.success) {
        throw new Error("Invalid backup code");
      }

      // For backup codes, we verify on our server
      // Then we can consider the MFA challenge passed
      // Note: For full security, you might want to integrate this
      // with Firebase's MFA flow or use a custom token

      // Clear state on success
      setState({
        isRequired: false,
        resolver: null,
        availableMethods: [],
        selectedMethod: null,
        enrolledFactors: [],
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Invalid backup code";
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  // Clear the MFA challenge state
  const clearChallenge = useCallback(() => {
    setState({
      isRequired: false,
      resolver: null,
      availableMethods: [],
      selectedMethod: null,
      enrolledFactors: [],
    });
    setError(null);
  }, []);

  return {
    // State
    isRequired: state.isRequired,
    resolver: state.resolver,
    availableMethods: state.availableMethods,
    selectedMethod: state.selectedMethod,
    enrolledFactors: state.enrolledFactors,
    loading,
    error,

    // Actions
    handleMfaRequired,
    handleCustomMfaRequired,
    selectMethod,
    verifyTotp,
    verifyPasskey,
    verifyBackupCode,
    clearChallenge,
  };
}
