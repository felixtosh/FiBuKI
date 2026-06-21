"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "./auth-provider";
import { MfaChallengeDialog } from "@/components/mfa";
import { useMfaChallenge } from "@/hooks/use-mfa-challenge";
import { FibukiMascot } from "@/components/ui/fibuki-mascot";

interface ProtectedRouteProps {
  children: React.ReactNode;
  requireAdmin?: boolean;
}

export function ProtectedRoute({
  children,
  requireAdmin = false,
}: ProtectedRouteProps) {
  const {
    user,
    isAdmin,
    loading,
    customMfaRequired,
    customMfaStatus,
    clearCustomMfaChallenge,
    completeCustomMfaChallenge,
    signOut,
  } = useAuth();
  const router = useRouter();
  const { handleCustomMfaRequired } = useMfaChallenge();

  useEffect(() => {
    if (!loading) {
      if (!user) {
        router.push("/login");
      } else if (requireAdmin && !isAdmin) {
        router.push("/transactions");
      }
    }
  }, [user, isAdmin, loading, requireAdmin, router]);

  // Trigger the MFA challenge handler when custom MFA is required
  useEffect(() => {
    if (customMfaRequired && customMfaStatus) {
      handleCustomMfaRequired(customMfaStatus);
    }
  }, [customMfaRequired, customMfaStatus, handleCustomMfaRequired]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen bg-background">
        <div className="flex flex-col items-center gap-3 animate-in fade-in duration-300">
          <div className="animate-pulse">
            <FibukiMascot size={48} forceFacingRight />
          </div>
          <p className="text-sm text-muted-foreground">One moment&hellip;</p>
        </div>
      </div>
    );
  }

  if (!user) {
    return null;
  }

  if (requireAdmin && !isAdmin) {
    return null;
  }

  // If custom MFA is required, show the MFA dialog and block content
  if (customMfaRequired) {
    return (
      <>
        <div className="flex items-center justify-center h-screen">
          <div className="flex flex-col items-center gap-4">
            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
            <p className="text-sm text-muted-foreground">Verifying identity...</p>
          </div>
        </div>
        <MfaChallengeDialog
          open={customMfaRequired}
          mfaStatus={customMfaStatus}
          onSuccess={() => {
            completeCustomMfaChallenge();
          }}
          onCancel={async () => {
            clearCustomMfaChallenge();
            await signOut();
            router.push("/login");
          }}
        />
      </>
    );
  }

  return <>{children}</>;
}
