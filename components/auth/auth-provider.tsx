"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  ReactNode,
} from "react";
import {
  User,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  GithubAuthProvider,
  OAuthProvider,
  linkWithCredential,
  signOut as firebaseSignOut,
  MultiFactorError,
  MultiFactorResolver,
  getMultiFactorResolver,
} from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { auth, functions } from "@/lib/firebase/config";
import { callFunction } from "@/lib/firebase/callable";
import { MfaStatusResponse, MfaMethod } from "@/types/mfa";

// Check if an error is an MFA required error
function isMfaError(error: unknown): error is MultiFactorError {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as { code: string }).code === "auth/multi-factor-auth-required"
  );
}

interface AuthContextValue {
  user: User | null;
  userId: string | null;
  isAdmin: boolean;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signInWithGitHub: () => Promise<void>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  refreshAdminStatus: () => Promise<void>;
  accessRequested: boolean;
  oauthError: string | null;
  clearOauthError: () => void;
  pendingLink: { email: string; pendingProvider: string } | null;
  // MFA challenge state (Firebase native TOTP)
  mfaRequired: boolean;
  mfaResolver: MultiFactorResolver | null;
  clearMfaChallenge: () => void;
  // Custom MFA state (Passkeys - not part of Firebase MFA)
  customMfaRequired: boolean;
  customMfaStatus: MfaStatusResponse | null;
  clearCustomMfaChallenge: () => void;
  completeCustomMfaChallenge: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const googleProvider = new GoogleAuthProvider();
const githubProvider = new GithubAuthProvider();

const MFA_SESSION_KEY = "fibuki_mfa_verified";
const PENDING_LINK_KEY = "fibuki_pending_link";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaResolver, setMfaResolver] = useState<MultiFactorResolver | null>(null);
  const [accessRequested, setAccessRequested] = useState(false);
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [pendingLink, setPendingLink] = useState<{
    email: string;
    pendingProvider: string;
  } | null>(null);
  // Custom MFA state for passkey-only users
  const [customMfaRequired, setCustomMfaRequired] = useState(false);
  const [customMfaStatus, setCustomMfaStatus] = useState<MfaStatusResponse | null>(null);

  // Check if MFA was already verified this session
  const isMfaVerifiedForSession = useCallback(() => {
    if (typeof window === "undefined") return false;
    return sessionStorage.getItem(MFA_SESSION_KEY) === "true";
  }, []);

  const setMfaVerifiedForSession = useCallback(() => {
    if (typeof window === "undefined") return;
    sessionStorage.setItem(MFA_SESSION_KEY, "true");
  }, []);

  const clearMfaVerifiedForSession = useCallback(() => {
    if (typeof window === "undefined") return;
    sessionStorage.removeItem(MFA_SESSION_KEY);
  }, []);

  const refreshAdminStatus = useCallback(async () => {
    if (!user) {
      setIsAdmin(false);
      return;
    }
    const token = await user.getIdTokenResult(true);
    setIsAdmin(!!token.claims.admin);
  }, [user]);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setUser(firebaseUser);

      if (firebaseUser) {
        // Get cached token first (no network call if valid)
        // Only force refresh if we need fresh claims.
        // Network may be unavailable during dev when emulators boot after the
        // app — fall back to false rather than throwing an unhandled rejection.
        try {
          const token = await firebaseUser.getIdTokenResult(false);
          setIsAdmin(!!token.claims.admin);
        } catch (err) {
          console.warn("[Auth] Failed to read ID token claims:", err);
          setIsAdmin(false);
        }

        // Set loading false immediately - don't block on MFA check
        setLoading(false);

        // Check MFA status in background (non-blocking)
        // Skip if MFA was already verified this session
        if (!isMfaVerifiedForSession()) {
          // Run in background - don't await
          (async () => {
            try {
              const getMfaStatusFn = httpsCallable<void, MfaStatusResponse>(
                functions,
                "getMfaStatus"
              );
              const result = await getMfaStatusFn();
              const mfaStatus = result.data;

              if (mfaStatus && mfaStatus.passkeysEnabled && !mfaStatus.totpEnabled) {
                // User has passkeys but no TOTP - require custom MFA verification
                setCustomMfaStatus(mfaStatus);
                setCustomMfaRequired(true);
              }
            } catch (err) {
              console.error("Error checking custom MFA status:", err);
            }
          })();
        }
      } else {
        setIsAdmin(false);
        // Clear MFA state when user signs out
        setCustomMfaRequired(false);
        setCustomMfaStatus(null);
        setLoading(false);
      }
    });

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible" && auth.currentUser) {
        // Force token refresh when tab becomes visible after being in background
        auth.currentUser.getIdToken(true).catch(() => {
          // Refresh failed - token revoked or network issue
          // onAuthStateChanged will handle the logout
        });
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      unsubscribe();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    try {
      await signInWithEmailAndPassword(auth, email, password);
      // Firebase auth succeeded - onAuthStateChanged will handle MFA check
    } catch (error) {
      if (isMfaError(error)) {
        // MFA is required - set up the resolver for the UI to handle
        const resolver = getMultiFactorResolver(auth, error);
        setMfaResolver(resolver);
        setMfaRequired(true);
        // Don't throw - the UI will show the MFA dialog
        return;
      }
      throw error;
    }
  }, []);

  const clearOauthError = useCallback(() => setOauthError(null), []);

  const clearMfaChallenge = useCallback(() => {
    setMfaRequired(false);
    setMfaResolver(null);
  }, []);

  const clearCustomMfaChallenge = useCallback(() => {
    setCustomMfaRequired(false);
    setCustomMfaStatus(null);
  }, []);

  const completeCustomMfaChallenge = useCallback(() => {
    setCustomMfaRequired(false);
    setMfaVerifiedForSession();
    // Keep customMfaStatus for reference, it will be cleared on next login
  }, [setMfaVerifiedForSession]);

  // Process a successful OAuth sign-in result. Validates new-user enrollment,
  // runs invite/access-request logic, completes any pending credential link.
  const processOAuthResult = useCallback(
    async (
      result: { user: User } | null,
      providerName: "google" | "github",
    ) => {
      if (!result) return;

      const pendingLinkData = sessionStorage.getItem(PENDING_LINK_KEY);
      if (pendingLinkData) {
        try {
          const { providerId, accessToken, idToken } = JSON.parse(pendingLinkData);
          let credential;
          if (providerId === "github.com") {
            credential = GithubAuthProvider.credential(accessToken);
          } else if (providerId === "google.com") {
            credential = GoogleAuthProvider.credential(idToken, accessToken);
          }
          if (credential) {
            await linkWithCredential(result.user, credential);
          }
        } catch (linkError) {
          console.warn("Failed to link credential:", linkError);
        } finally {
          sessionStorage.removeItem(PENDING_LINK_KEY);
          setPendingLink(null);
          setOauthError(null);
        }
        return;
      }

      const email = result.user.email;
      const isNewUser =
        result.user.metadata.creationTime === result.user.metadata.lastSignInTime;

      if (isNewUser && email) {
        const validateFn = httpsCallable<
          { email: string },
          { allowed: boolean; reason?: string }
        >(functions, "validateRegistration");

        const validation = await validateFn({ email: email.toLowerCase() });

        if (!validation.data.allowed) {
          try {
            const submitFn = httpsCallable(functions, "submitAccessRequest");
            await submitFn({ provider: providerName });
          } catch (e) {
            console.warn("Failed to submit access request:", e);
          }

          await result.user.delete();
          setAccessRequested(true);
          return;
        }

        try {
          const markUsedFn = httpsCallable(functions, "markInviteUsed");
          await markUsedFn({});
        } catch (e) {
          console.warn("Failed to mark invite as used:", e);
        }
      }
    },
    [],
  );

  const handleOAuthError = useCallback((error: unknown) => {
    if (isMfaError(error)) {
      const resolver = getMultiFactorResolver(auth, error as Parameters<typeof getMultiFactorResolver>[1]);
      setMfaResolver(resolver);
      setMfaRequired(true);
      return;
    }
    console.error("OAuth error:", error);
    const code = (error as { code?: string })?.code;
    if (code === "auth/account-exists-with-different-credential") {
      const credential = OAuthProvider.credentialFromError(error as Parameters<typeof OAuthProvider.credentialFromError>[0]);
      const email = (error as { customData?: { email?: string } })?.customData?.email;
      const pendingProvider = credential?.providerId || "unknown";

      if (credential && email) {
        const linkData = {
          providerId: credential.providerId,
          accessToken: (credential as { accessToken?: string }).accessToken || null,
          idToken: (credential as { idToken?: string }).idToken || null,
        };
        sessionStorage.setItem(PENDING_LINK_KEY, JSON.stringify(linkData));
        setPendingLink({ email, pendingProvider });
        setOauthError(
          `This email is already registered with a different method. Sign in with your existing account to link ${
            pendingProvider === "github.com" ? "GitHub" : "Google"
          }.`,
        );
      } else {
        setOauthError(
          "An account with this email already exists using a different sign-in method.",
        );
      }
    } else if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") {
      // User dismissed the popup — not a real error
      return;
    } else if (code) {
      setOauthError(
        (error as { message?: string })?.message || "OAuth sign-in failed. Please try again.",
      );
    }
  }, []);

  // Use signInWithPopup in both dev and prod:
  // - Dev: Firebase Auth Emulator + signInWithRedirect can't complete the
  //   apis.google.com iframe handshake against localhost.
  // - Prod: since Chrome M115/Firefox 109/Safari 16.1 (June 2024) blocked
  //   third-party cookies in cross-site iframes, signInWithRedirect needs a
  //   custom authDomain or reverse proxy. Popup sidesteps that entirely.
  //   See https://firebase.google.com/docs/auth/web/redirect-best-practices
  const handleOAuthSignIn = useCallback(
    async (
      provider: GoogleAuthProvider | GithubAuthProvider,
      providerName: "google" | "github",
    ) => {
      try {
        const result = await signInWithPopup(auth, provider);
        await processOAuthResult(result, providerName);
      } catch (error) {
        handleOAuthError(error);
      }
    },
    [processOAuthResult, handleOAuthError],
  );

  const signInWithGoogle = useCallback(
    () => handleOAuthSignIn(googleProvider, "google"),
    [handleOAuthSignIn]
  );

  const signInWithGitHub = useCallback(
    () => handleOAuthSignIn(githubProvider, "github"),
    [handleOAuthSignIn]
  );

  const signOut = useCallback(async () => {
    clearMfaVerifiedForSession();
    await firebaseSignOut(auth);
  }, [clearMfaVerifiedForSession]);

  const resetPassword = useCallback(async (email: string) => {
    await callFunction<{ email: string }, { success: boolean }>(
      "sendPasswordReset",
      { email }
    );
  }, []);

  const value: AuthContextValue = {
    user,
    userId: user?.uid ?? null,
    isAdmin,
    loading,
    signIn,
    signInWithGoogle,
    signInWithGitHub,
    signOut,
    resetPassword,
    refreshAdminStatus,
    accessRequested,
    oauthError,
    clearOauthError,
    pendingLink,
    // MFA challenge state (Firebase native TOTP)
    mfaRequired,
    mfaResolver,
    clearMfaChallenge,
    // Custom MFA state (Passkeys - not part of Firebase MFA)
    customMfaRequired,
    customMfaStatus,
    clearCustomMfaChallenge,
    completeCustomMfaChallenge,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an AuthProvider");
  }
  return context;
}
