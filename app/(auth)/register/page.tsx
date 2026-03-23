"use client";

import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useAuth } from "@/components/auth";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { AlertCircle, CheckCircle, Info, Loader2, Gift, Sparkles } from "lucide-react";
import { FibukiMascot } from "@/components/ui/fibuki-mascot";
import { logoFont } from "@/app/fonts";
import { callFunction } from "@/lib/firebase/callable";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "@/lib/firebase/config";

export default function RegisterPage() {
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isLogoJumping, setIsLogoJumping] = useState(false);
  const [pendingRedirect, setPendingRedirect] = useState(() => {
    if (typeof window === "undefined") return false;
    return !!sessionStorage.getItem("fibuki_oauth_provider");
  });
  const [referralApplied, setReferralApplied] = useState(false);
  const [hasReferral, setHasReferral] = useState(false);
  const [openSeats, setOpenSeats] = useState<{ total: number; remaining: number; claimed: number } | null>(null);
  const router = useRouter();
  const searchParams = useSearchParams();

  // Listen for open seats config (public read, no auth needed)
  useEffect(() => {
    const unsub = onSnapshot(
      doc(db, "config", "openSeats"),
      (snap) => {
        if (snap.exists()) {
          const data = snap.data();
          const remaining = data.remainingSeats as number;
          const total = data.totalSeats as number;
          const claimed = (data.claimedSeats as number) || 0;
          if (remaining > 0) {
            setOpenSeats({ total, remaining, claimed });
          } else {
            setOpenSeats(null);
          }
        } else {
          setOpenSeats(null);
        }
      },
      () => setOpenSeats(null)
    );
    return () => unsub();
  }, []);

  // Store referral code from URL in localStorage for persistence across OAuth redirects
  useEffect(() => {
    const ref = searchParams.get("ref");
    if (ref) {
      localStorage.setItem("fibuki_referral_code", ref);
      setHasReferral(true);
    } else if (typeof window !== "undefined" && localStorage.getItem("fibuki_referral_code")) {
      setHasReferral(true);
    }
  }, [searchParams]);

  const handleLogoClick = () => {
    if (isLogoJumping) return;
    setIsLogoJumping(true);
    setTimeout(() => setIsLogoJumping(false), 600);
  };

  const { user, signInWithGoogle, signInWithGitHub, accessRequested } = useAuth();

  // Redirect existing users to the dashboard
  useEffect(() => {
    if (user && !accessRequested) {
      router.push("/transactions");
    }
  }, [user, accessRequested, router]);

  // Clear pending redirect state once auth resolves
  useEffect(() => {
    if (!pendingRedirect) return;
    if (user || accessRequested) {
      setPendingRedirect(false);
      return;
    }
    const timeout = setTimeout(() => setPendingRedirect(false), 5000);
    return () => clearTimeout(timeout);
  }, [pendingRedirect, user, accessRequested]);

  // After successful registration, apply referral code
  useEffect(() => {
    if (!user || referralApplied) return;
    const ref = localStorage.getItem("fibuki_referral_code");
    if (!ref) return;

    callFunction<{ code: string }, { valid: boolean; referrerName?: string }>(
      "applyReferralCode",
      { code: ref }
    )
      .then((res) => {
        if (res.valid) {
          setReferralApplied(true);
        }
        localStorage.removeItem("fibuki_referral_code");
      })
      .catch(() => {
        localStorage.removeItem("fibuki_referral_code");
      });
  }, [user, referralApplied]);

  const handleGoogleSignUp = async () => {
    setError("");
    setIsLoading(true);
    try {
      await signInWithGoogle();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to sign in with Google."
      );
    } finally {
      setIsLoading(false);
    }
  };

  const handleGitHubSignUp = async () => {
    setError("");
    setIsLoading(true);
    try {
      await signInWithGitHub();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Failed to sign in with GitHub."
      );
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Card className="w-full max-w-md">
      <CardHeader className="space-y-1 text-center">
        <div className="flex justify-center mb-4">
          <Link
            href="/"
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
          </Link>
        </div>
        <CardTitle className="text-2xl">Request Access</CardTitle>
        <CardDescription>
          {openSeats ? "Open seats available! Sign in to claim yours." : "FiBuKI is invite-only. Sign in to request access."}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {pendingRedirect ? (
          <div className="flex flex-col items-center gap-3 py-8">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">Signing you in...</p>
          </div>
        ) : (
          <>
            {openSeats && (
              <div className="space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="flex items-center gap-1.5 font-medium text-green-700 dark:text-green-400">
                    <Sparkles className="h-4 w-4" />
                    {openSeats.remaining} open seat{openSeats.remaining === 1 ? "" : "s"} available
                  </span>
                  <span className="text-muted-foreground text-xs">
                    {openSeats.claimed}/{openSeats.total} claimed
                  </span>
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full rounded-full bg-green-500 transition-all duration-500"
                    style={{ width: `${(openSeats.claimed / openSeats.total) * 100}%` }}
                  />
                </div>
              </div>
            )}
            {hasReferral && !referralApplied && (
              <Alert className="border-green-200 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/50 dark:text-green-300">
                <Gift className="h-4 w-4 text-green-600 dark:text-green-400" />
                <AlertDescription>
                  You&apos;ve been referred! Sign up to get <strong>€20 off</strong> your first yearly plan.
                </AlertDescription>
              </Alert>
            )}

            {referralApplied && (
              <Alert className="border-green-200 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/50 dark:text-green-300">
                <CheckCircle className="h-4 w-4 text-green-600 dark:text-green-400" />
                <AlertDescription>
                  Referral discount applied! You&apos;ll get €20 off when you choose a yearly plan.
                </AlertDescription>
              </Alert>
            )}

            {accessRequested ? (
              <Alert className="border-green-200 bg-green-50 text-green-900">
                <CheckCircle className="h-4 w-4 text-green-600" />
                <AlertDescription>
                  Access request submitted! An admin will review it shortly.
                </AlertDescription>
              </Alert>
            ) : (
              <>
                <Alert>
                  <Info className="h-4 w-4" />
                  <AlertDescription>
                    Sign in with Google or GitHub to request access. An admin will
                    review your request.
                  </AlertDescription>
                </Alert>

                {error && (
                  <Alert variant="destructive">
                    <AlertCircle className="h-4 w-4" />
                    <AlertDescription>{error}</AlertDescription>
                  </Alert>
                )}

                <Button
                  variant="outline"
                  className="w-full"
                  onClick={handleGoogleSignUp}
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
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
                  )}
                  Continue with Google
                </Button>

                <Button
                  variant="outline"
                  className="w-full"
                  onClick={handleGitHubSignUp}
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <svg className="mr-2 h-4 w-4" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                    </svg>
                  )}
                  Continue with GitHub
                </Button>
              </>
            )}

            <p className="text-xs text-muted-foreground text-center">
              By requesting access, you agree to our{" "}
              <Link href="/privacy" className="text-primary hover:underline">
                Privacy Policy
              </Link>
              .
            </p>
          </>
        )}
      </CardContent>
      <CardFooter>
        <p className="text-sm text-muted-foreground w-full text-center">
          Already have an account?{" "}
          <Link href="/login" className="text-primary hover:underline">
            Sign in
          </Link>
        </p>
      </CardFooter>
    </Card>
  );
}
