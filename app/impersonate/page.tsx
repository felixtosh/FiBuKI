"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signInWithCustomToken, signOut as firebaseSignOut } from "firebase/auth";
import { auth } from "@/lib/firebase/config";
import { Loader2, AlertCircle } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

const IMPERSONATION_KEY = "fibuki_impersonation_session";

export default function ImpersonatePage() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("Preparing impersonation session...");

  useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const hash = window.location.hash.slice(1);
      if (!hash) {
        setError("No impersonation token provided. Open this page via the admin user panel.");
        return;
      }

      let payload: {
        token: string;
        targetEmail: string | null;
        adminEmail: string;
      };
      try {
        payload = JSON.parse(decodeURIComponent(hash));
      } catch {
        setError("Invalid impersonation token payload.");
        return;
      }

      // Strip the token from the URL immediately so it never lands in browser
      // history or refresh state.
      window.history.replaceState(null, "", "/impersonate");

      try {
        // Sign out any existing session in this tab first.
        await firebaseSignOut(auth);

        setStatus("Signing in as user...");
        await signInWithCustomToken(auth, payload.token);

        if (cancelled) return;

        // Record the impersonation state so the dashboard layout can show a
        // banner. sessionStorage is per-tab so the admin's own tab is unaffected.
        sessionStorage.setItem(
          IMPERSONATION_KEY,
          JSON.stringify({
            targetEmail: payload.targetEmail,
            adminEmail: payload.adminEmail,
            startedAt: Date.now(),
          }),
        );

        router.replace("/transactions");
      } catch (err) {
        if (cancelled) return;
        console.error("Impersonation sign-in failed:", err);
        setError(
          err instanceof Error
            ? err.message
            : "Failed to sign in as the impersonated user.",
        );
      }
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [router]);

  return (
    <div className="min-h-screen flex items-center justify-center p-6 bg-background">
      <div className="max-w-md w-full">
        {error ? (
          <Alert variant="destructive">
            <AlertCircle className="h-4 w-4" />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : (
          <div className="flex flex-col items-center gap-3 text-center">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{status}</p>
          </div>
        )}
      </div>
    </div>
  );
}
