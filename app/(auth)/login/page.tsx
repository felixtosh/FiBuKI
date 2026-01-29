"use client";

import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/components/auth";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, Loader2 } from "lucide-react";
import { FibukiMascot } from "@/components/ui/fibuki-mascot";
import { MfaChallengeDialog } from "@/components/mfa";
import { useMfaChallenge } from "@/hooks/use-mfa-challenge";
import { usePasskeys } from "@/hooks/use-passkeys";
import { logoFont } from "@/app/fonts";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isLogoJumping, setIsLogoJumping] = useState(false);

  const handleLogoClick = () => {
    if (isLogoJumping) return;
    setIsLogoJumping(true);
    setTimeout(() => setIsLogoJumping(false), 600);
  };
  const {
    user,
    signIn,
    signInWithGoogle,
    signOut,
    mfaRequired,
    mfaResolver,
    clearMfaChallenge,
    customMfaRequired,
    customMfaStatus,
    clearCustomMfaChallenge,
    completeCustomMfaChallenge,
  } = useAuth();
  const { handleMfaRequired, handleCustomMfaRequired } = useMfaChallenge();
  const { hasPasskeys } = usePasskeys();
  const router = useRouter();

  // When Firebase MFA is required by the auth provider, trigger the MFA challenge handler
  useEffect(() => {
    if (mfaRequired && mfaResolver) {
      // Create a mock error to pass to the challenge handler
      const mfaError = {
        code: "auth/multi-factor-auth-required",
        customData: { _serverResponse: { mfaInfo: mfaResolver.hints } },
      } as unknown as import("firebase/auth").MultiFactorError;
      handleMfaRequired(mfaError, hasPasskeys);
    }
  }, [mfaRequired, mfaResolver, handleMfaRequired, hasPasskeys]);

  // When custom MFA is required (passkey-only users), trigger the custom MFA handler
  useEffect(() => {
    if (customMfaRequired && customMfaStatus) {
      handleCustomMfaRequired(customMfaStatus);
    }
  }, [customMfaRequired, customMfaStatus, handleCustomMfaRequired]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setIsLoading(true);

    try {
      await signIn(email, password);
      // Don't navigate yet - the useEffect will check if customMfaRequired is set
      // and show the MFA dialog. Only navigate if no MFA is needed.
      // We check this via a small delay to allow state to update
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to sign in. Please check your credentials."
      );
    } finally {
      setIsLoading(false);
    }
  };

  // Navigate to dashboard after successful login (when no MFA is pending)
  useEffect(() => {
    // Only redirect if:
    // 1. User is logged in
    // 2. No Firebase MFA challenge is pending
    // 3. No custom MFA challenge is pending
    // 4. Not currently loading
    if (user && !mfaRequired && !customMfaRequired && !isLoading) {
      router.push("/transactions");
    }
  }, [user, mfaRequired, customMfaRequired, isLoading, router]);

  const handleGoogleSignIn = async () => {
    setError("");
    setIsLoading(true);

    try {
      await signInWithGoogle();
      // Don't navigate - the useEffect will handle navigation after MFA check
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to sign in with Google."
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="space-y-1 text-center">
        <div className="flex justify-center mb-4">
          <button
            type="button"
            onClick={handleLogoClick}
            className={cn(
              "flex items-center gap-2 logo-wrapper",
              isLogoJumping && "is-jumping"
            )}
          >
            <FibukiMascot size={32} isJumping={isLogoJumping} />
            <span className={cn("font-bold text-2xl mascot-text", logoFont.className)}>
              FiBuKI
            </span>
          </button>
        </div>
        <CardTitle className="text-2xl">Sign in</CardTitle>
        <CardDescription>
          Enter your email and password to access your account
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              placeholder="you@example.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              disabled={isLoading}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              disabled={isLoading}
            />
          </div>
          <Button type="submit" className="w-full" disabled={isLoading}>
            {isLoading ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                Signing in...
              </>
            ) : (
              "Sign In"
            )}
          </Button>
        </form>

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <span className="w-full border-t" />
          </div>
          <div className="relative flex justify-center text-xs uppercase">
            <span className="bg-card px-2 text-muted-foreground">
              Or continue with
            </span>
          </div>
        </div>

        <Button
          variant="outline"
          className="w-full"
          onClick={handleGoogleSignIn}
          disabled={isLoading}
        >
          <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24">
            <path
              d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
              fill="#4285F4"
            />
            <path
              d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
              fill="#34A853"
            />
            <path
              d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
              fill="#FBBC05"
            />
            <path
              d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
              fill="#EA4335"
            />
          </svg>
          Continue with Google
        </Button>
      </CardContent>
      <CardFooter className="flex flex-col space-y-2">
        <Link
          href="/reset-password"
          className="text-sm text-primary hover:underline"
        >
          Forgot your password?
        </Link>
        <p className="text-sm text-muted-foreground">
          Don&apos;t have an account?{" "}
          <Link href="/register" className="text-primary hover:underline">
            Request access
          </Link>
        </p>
      </CardFooter>

      {/* MFA Challenge Dialog - Firebase MFA (TOTP) */}
      <MfaChallengeDialog
        open={mfaRequired}
        onSuccess={() => {
          clearMfaChallenge();
          router.push("/transactions");
        }}
        onCancel={() => {
          clearMfaChallenge();
          setError("Two-factor authentication is required");
        }}
      />

      {/* MFA Challenge Dialog - Custom MFA (Passkeys) */}
      <MfaChallengeDialog
        open={customMfaRequired}
        mfaStatus={customMfaStatus}
        onSuccess={() => {
          completeCustomMfaChallenge();
          router.push("/transactions");
        }}
        onCancel={async () => {
          // Sign out the user since they cancelled MFA verification
          clearCustomMfaChallenge();
          await signOut();
          setError("Two-factor authentication is required");
        }}
      />
    </Card>
  );
}
