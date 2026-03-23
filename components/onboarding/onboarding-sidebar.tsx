"use client";

import { useRouter, usePathname } from "next/navigation";
import {
  Building2,
  Upload,
  Users,
  FileCheck,
  Check,
  ChevronRight,
  Loader2,
  User,
  Mail,
  Plug,
  SkipForward,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useOnboarding } from "@/hooks/use-onboarding";
import { OnboardingStepConfig, OnboardingStep } from "@/types/onboarding";

// Map icon names to components
const iconMap: Record<string, React.ComponentType<{ className?: string }>> = {
  Building2,
  Upload,
  Users,
  FileCheck,
  User,
  Mail,
  Plug,
};

interface StepItemProps {
  step: OnboardingStepConfig;
  index: number;
  isCompleted: boolean;
  isSkipped: boolean;
  isCurrent: boolean;
  isInProgress: boolean;
  onNavigate: () => void;
  onSkip?: () => void;
}

function StepItem({
  step,
  index,
  isCompleted,
  isSkipped,
  isCurrent,
  isInProgress,
  onNavigate,
  onSkip,
}: StepItemProps) {
  const Icon = iconMap[step.icon] || FileCheck;

  return (
    <div
      className={cn(
        "relative flex gap-3 p-3 rounded-lg transition-colors",
        isCurrent && "bg-primary/10 border border-primary/20",
        isCompleted && !isCurrent && "opacity-80",
        isSkipped && !isCurrent && "opacity-70"
      )}
    >
      {/* Step number / check icon */}
      <div
        className={cn(
          "flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm font-medium",
          isCompleted
            ? "bg-emerald-500 text-white"
            : isSkipped
            ? "bg-muted text-muted-foreground"
            : isCurrent
            ? "bg-primary/20 text-primary border-2 border-primary"
            : "bg-muted text-muted-foreground"
        )}
      >
        {isCompleted ? (
          <Check className="h-4 w-4" />
        ) : isSkipped ? (
          <SkipForward className="h-3.5 w-3.5" />
        ) : isInProgress ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          index + 1
        )}
      </div>

      {/* Step content */}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <Icon className={cn(
            "h-4 w-4",
            isCurrent ? "text-primary" : "text-muted-foreground"
          )} />
          <span
            className={cn(
              "font-medium text-sm",
              isCurrent && "text-primary",
              isCompleted && "line-through",
              isSkipped && "line-through"
            )}
          >
            {step.title}
          </span>
          {isSkipped && (
            <span className="text-[10px] text-muted-foreground">Skipped</span>
          )}
        </div>
        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">
          {step.description}
        </p>

        {/* Navigate button or in-progress indicator for current step */}
        {isCurrent && (
          isInProgress ? (
            <div className="mt-2 flex items-center gap-1.5 text-xs text-primary font-medium">
              <Loader2 className="h-3 w-3 animate-spin" />
              In progress...
            </div>
          ) : (
            <div className="mt-2 flex items-center gap-2">
              <Button
                size="sm"
                className="h-7 text-xs"
                onClick={onNavigate}
              >
                Go to step
                <ChevronRight className="h-3 w-3 ml-1" />
              </Button>
              {onSkip && (
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-7 text-xs text-muted-foreground"
                  onClick={onSkip}
                >
                  Skip
                </Button>
              )}
            </div>
          )
        )}
      </div>
    </div>
  );
}

/**
 * Check if user is actively working on a step based on current pathname
 */
function isUserInProgressOnStep(stepId: OnboardingStep, pathname: string): boolean {
  switch (stepId) {
    case "set_identity":
      // User is on identity settings page
      return pathname === "/settings/identity";
    case "connect_email":
      // User is on Gmail integration or email inbound page
      return pathname === "/integrations/gmail" || pathname === "/integrations/email-inbound";
    case "add_bank_account":
      // User is on sources page (adding account)
      return pathname === "/sources" || pathname === "/sources/connect";
    case "import_transactions":
      // User is on import page for any source
      return pathname.match(/^\/sources\/[^/]+\/import/) !== null;
    case "test_integration":
      // User is on integrations page or a specific integration sub-page
      return pathname === "/settings/integrations" || pathname.startsWith("/integrations/");
    case "assign_partner":
      // User is on transactions page (assigning partner)
      return pathname === "/transactions";
    case "attach_file":
      // User is on transactions page (attaching file to transaction)
      // Note: /files page doesn't count as "in progress" since the step is about
      // attaching files TO transactions, not just viewing files
      return pathname === "/transactions";
    default:
      return false;
  }
}

export function OnboardingSidebar() {
  const router = useRouter();
  const pathname = usePathname();
  const {
    steps,
    currentStep,
    isStepCompleted,
    isStepSkipped,
    progress,
    loading,
    skipOnboarding,
    skipStep,
    track,
  } = useOnboarding();

  const handleNavigate = (route: string) => {
    if (pathname !== route) {
      router.push(route);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b">
        <h2 className="font-semibold text-lg">
          {track === "data_only" ? "Set Up Bank Data" : "Getting Started"}
        </h2>
        <p className="text-sm text-muted-foreground mt-1">
          {track === "data_only"
            ? "Connect your bank to start using the API"
            : "Complete these steps to set up your account"}
        </p>

        {/* Progress bar */}
        <div className="mt-4">
          <div className="flex items-center justify-between text-xs text-muted-foreground mb-1.5">
            <span>Progress</span>
            <span>{progress.completed} of {progress.total} complete</span>
          </div>
          <Progress value={progress.percentage} className="h-2 [&>div]:bg-emerald-500" />
        </div>
      </div>

      {/* Steps list */}
      <ScrollArea className="flex-1">
        <div className="p-4 space-y-2">
          {steps.map((step, index) => {
            const isCompleted = isStepCompleted(step.id);
            const isSkipped = isStepSkipped(step.id);
            const isCurrent = currentStep === step.id;
            const isInProgress = isCurrent && isUserInProgressOnStep(step.id, pathname);

            return (
              <StepItem
                key={step.id}
                step={step}
                index={index}
                isCompleted={isCompleted}
                isSkipped={isSkipped}
                isCurrent={isCurrent}
                isInProgress={isInProgress}
                onNavigate={() => handleNavigate(step.route)}
                onSkip={isCurrent ? () => skipStep(step.id) : undefined}
              />
            );
          })}
        </div>
      </ScrollArea>

      {/* Footer */}
      <div className="p-4 border-t space-y-2">
        <Button
          variant="ghost"
          size="sm"
          className="w-full h-7 text-xs text-muted-foreground"
          onClick={skipOnboarding}
        >
          <SkipForward className="h-3 w-3 mr-1" />
          Skip setup
        </Button>
      </div>
    </div>
  );
}
