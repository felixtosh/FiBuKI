"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Welcome } from "@/components/onboarding/welcome";
import { useOnboarding } from "@/hooks/use-onboarding";

export default function WelcomePage() {
  const { needsWelcome, loading } = useOnboarding();
  const router = useRouter();

  // Nothing to welcome: onboarding is done, or the welcome was already seen.
  useEffect(() => {
    if (loading) return;
    if (!needsWelcome) router.replace("/transactions");
  }, [needsWelcome, loading, router]);

  if (loading || !needsWelcome) return null;

  return (
    <div className="h-full flex items-center justify-center p-4">
      <Welcome />
    </div>
  );
}
