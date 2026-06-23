"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signOut as firebaseSignOut } from "firebase/auth";
import { auth } from "@/lib/firebase/config";
import { UserCog, X, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";

const IMPERSONATION_KEY = "fibuki_impersonation_session";

type ImpersonationState = {
  targetEmail: string | null;
  adminEmail: string;
  startedAt: number;
};

/**
 * Renders a persistent banner at the top of the dashboard when the current
 * session was started via the admin Impersonate flow. Clicking "Exit" signs
 * out and clears the marker — sessionStorage is per-tab so the admin's own
 * tab is unaffected.
 */
export function ImpersonationBanner() {
  const router = useRouter();
  const [state, setState] = useState<ImpersonationState | null>(null);
  const [exiting, setExiting] = useState(false);

  useEffect(() => {
    queueMicrotask(() => {
      const raw = sessionStorage.getItem(IMPERSONATION_KEY);
      if (!raw) return;
      try {
        setState(JSON.parse(raw) as ImpersonationState);
      } catch {
        sessionStorage.removeItem(IMPERSONATION_KEY);
      }
    });
  }, []);

  if (!state) return null;

  const handleExit = async () => {
    setExiting(true);
    sessionStorage.removeItem(IMPERSONATION_KEY);
    try {
      await firebaseSignOut(auth);
    } catch (err) {
      console.warn("Failed to sign out of impersonation session:", err);
    }
    router.replace("/login");
  };

  return (
    <div className="w-full bg-amber-500/15 border-b border-amber-500/40 px-4 py-2 flex-shrink-0 flex items-center justify-between gap-3">
      <div className="flex items-center gap-2 min-w-0 text-sm text-amber-900 dark:text-amber-200">
        <UserCog className="h-4 w-4 flex-shrink-0" />
        <span className="truncate">
          Impersonating <strong>{state.targetEmail ?? "(unknown email)"}</strong>{" "}
          <span className="text-amber-900/70 dark:text-amber-200/70">
            · as admin {state.adminEmail}
          </span>
        </span>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="h-7 px-2 text-xs flex-shrink-0 border-amber-500/50"
        onClick={handleExit}
        disabled={exiting}
      >
        {exiting ? (
          <Loader2 className="h-3 w-3 mr-1 animate-spin" />
        ) : (
          <X className="h-3 w-3 mr-1" />
        )}
        Exit impersonation
      </Button>
    </div>
  );
}
