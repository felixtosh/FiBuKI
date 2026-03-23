"use client";

import { usePathname } from "next/navigation";
import { useOnboarding } from "@/hooks/use-onboarding";
import { HighlightPin } from "./highlight-pin";

// Map step IDs to human-readable labels for the highlight pin
const stepLabels: Record<string, string> = {
  set_identity: "Fill in your details",
  connect_email: "Connect your email",
  add_bank_account: "Start here",
  import_transactions: "Import your transactions",
  test_integration: "Try an integration method",
  assign_partner: "Assign a partner",
  attach_file: "Drop a file here or connect a service",
};

// Map steps to their expected routes
const stepRoutes: Record<string, string[]> = {
  set_identity: ["/settings/identity"],
  connect_email: ["/integrations/gmail", "/integrations/email-inbound"],
  add_bank_account: ["/sources"],
  import_transactions: ["/sources"],
  test_integration: ["/settings/integrations"],
  assign_partner: ["/transactions"],
  attach_file: ["/transactions"],
};

/**
 * Global overlay component that renders highlight pins for the current onboarding step
 * Only shows pins when the user is on the correct route for the current step
 */
export function OnboardingOverlay() {
  const pathname = usePathname();
  const { isOnboarding, currentStep, currentStepConfig } = useOnboarding();

  // Don't render anything if not onboarding or no current step
  if (!isOnboarding || !currentStep || !currentStepConfig) {
    return null;
  }

  // Check if we're on a valid route for the current step
  const validRoutes = stepRoutes[currentStep] || [];
  const isOnValidRoute = validRoutes.some((route) => pathname.startsWith(route));

  // Only show highlight pin when on the correct route
  if (!isOnValidRoute) {
    return null;
  }

  return (
    <HighlightPin
      target={currentStepConfig.highlightTarget}
      active={true}
      label={stepLabels[currentStep]}
      labelPosition="right"
      scrollIntoView={true}
      dismissOnInteraction={currentStep === "set_identity"}
    />
  );
}
