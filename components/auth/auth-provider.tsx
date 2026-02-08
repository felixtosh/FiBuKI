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
  createUserWithEmailAndPassword,
  signInWithPopup,
  GoogleAuthProvider,
  signOut as firebaseSignOut,
  sendPasswordResetEmail,
  MultiFactorError,
  MultiFactorResolver,
  getMultiFactorResolver,
} from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import { auth, functions } from "@/lib/firebase/config";
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
  signUp: (email: string, password: string) => Promise<void>;
  signInWithGoogle: () => Promise<void>;
  signOut: () => Promise<void>;
  resetPassword: (email: string) => Promise<void>;
  refreshAdminStatus: () => Promise<void>;
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

const MFA_SESSION_KEY = "fibuki_mfa_verified";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [loading, setLoading] = useState(true);
  const [mfaRequired, setMfaRequired] = useState(false);
  const [mfaResolver, setMfaResolver] = useState<MultiFactorResolver | null>(null);
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
        // Only force refresh if we need fresh claims
        const token = await firebaseUser.getIdTokenResult(false);
        setIsAdmin(!!token.claims.admin);

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

    return () => unsubscribe();
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

  const signUp = useCallback(async (email: string, password: string) => {
    // Validate registration against allowedEmails
    const validateFn = httpsCallable<
      { email: string },
      { allowed: boolean; reason?: string }
    >(functions, "validateRegistration");

    const result = await validateFn({ email: email.toLowerCase() });

    if (!result.data.allowed) {
      throw new Error(
        result.data.reason ||
          "Registration not allowed. Please request an invite from an admin."
      );
    }

    await createUserWithEmailAndPassword(auth, email, password);

    // Mark invite as used after successful registration
    try {
      const markUsedFn = httpsCallable(functions, "markInviteUsed");
      await markUsedFn({});
    } catch (e) {
      console.warn("Failed to mark invite as used:", e);
    }
  }, []);

  const signInWithGoogle = useCallback(async () => {
    try {
      const result = await signInWithPopup(auth, googleProvider);
      const email = result.user.email;

      // For new users signing up with Google, validate against allowedEmails
      // Check if this is a new user by checking metadata
      const isNewUser =
        result.user.metadata.creationTime === result.user.metadata.lastSignInTime;

      if (isNewUser && email) {
        const validateFn = httpsCallable<
          { email: string },
          { allowed: boolean; reason?: string }
        >(functions, "validateRegistration");

        const validation = await validateFn({ email: email.toLowerCase() });

        if (!validation.data.allowed) {
          // Delete the newly created account and throw error
          await result.user.delete();
          throw new Error(
            "Registration not allowed. Please request an invite from an admin."
          );
        }

        // Mark invite as used (Google sign-up doesn't go through email/password flow)
        try {
          const markUsedFn = httpsCallable(functions, "markInviteUsed");
          await markUsedFn({});
        } catch (e) {
          console.warn("Failed to mark invite as used:", e);
        }
      }
      // Firebase auth succeeded - onAuthStateChanged will handle MFA check
    } catch (error) {
      if (isMfaError(error)) {
        // MFA is required - set up the resolver for the UI to handle
        const resolver = getMultiFactorResolver(auth, error);
        setMfaResolver(resolver);
        setMfaRequired(true);
        return;
      }
      throw error;
    }
  }, []);

  const signOut = useCallback(async () => {
    clearMfaVerifiedForSession();
    await firebaseSignOut(auth);
  }, [clearMfaVerifiedForSession]);

  const resetPassword = useCallback(async (email: string) => {
    await sendPasswordResetEmail(auth, email);
  }, []);

  const value: AuthContextValue = {
    user,
    userId: user?.uid ?? null,
    isAdmin,
    loading,
    signIn,
    signUp,
    signInWithGoogle,
    signOut,
    resetPassword,
    refreshAdminStatus,
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
