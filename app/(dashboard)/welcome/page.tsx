"use client";

import { WelcomeChoice } from "@/components/onboarding/welcome-choice";
import { useOnboarding } from "@/hooks/use-onboarding";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function WelcomePage() {
  const { state, loading } = useOnboarding();
  const router = useRouter();

  // If track is already set or onboarding is complete, redirect to first step
  useEffect(() => {
    if (loading) return;
    if (state?.isComplete) {
      router.replace("/transactions");
    } else if (state?.track === "data_only") {
      router.replace("/sources");
    } else if (state?.track === "full_service") {
      router.replace("/settings/identity");
    }
  }, [state, loading, router]);

  if (loading || state?.track || state?.isComplete) {
    return null;
  }

  return (
    <div className="h-full flex items-center justify-center p-4">
      <WelcomeChoice />
    </div>
  );
}
