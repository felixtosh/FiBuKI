"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Terminal, Sparkles, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { callFunction } from "@/lib/firebase/callable";
import type { OnboardingTrack } from "@/types/onboarding";

const tracks: {
  id: OnboardingTrack;
  title: string;
  subtitle: string;
  description: string;
  icon: typeof Terminal;
  features: string[];
}[] = [
  {
    id: "data_only",
    title: "Bank Data Only",
    subtitle: "For developers & AI builders",
    description: "Access your banking data with MCP, API, and Claude Code. Perfect for AI-first workflows.",
    icon: Terminal,
    features: [
      "Bank data API & MCP access",
      "Connect to Claude, ChatGPT, OpenClaw",
      "CSV/JSON export",
      "Programmatic transaction access",
    ],
  },
  {
    id: "full_service",
    title: "Full Service",
    subtitle: "AI-powered bookkeeping",
    description: "Let AI handle matching, extraction, and pre-accounting. Everything in Data plus full automation.",
    icon: Sparkles,
    features: [
      "Everything in Data",
      "AI receipt matching & extraction",
      "Gmail invoice import",
      "Partner intelligence & chat assistant",
    ],
  },
];

export function WelcomeChoice() {
  const router = useRouter();
  const [selected, setSelected] = useState<OnboardingTrack | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleConfirm = async () => {
    if (!selected) return;
    setSubmitting(true);
    try {
      await callFunction("setOnboardingTrack", { track: selected });
      // Redirect based on track
      if (selected === "data_only") {
        router.push("/sources");
      } else {
        router.push("/settings/identity");
      }
    } catch (err) {
      console.error("Failed to set onboarding track:", err);
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-3xl w-full space-y-8 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header */}
      <div className="text-center space-y-2">
        <h1 className="text-2xl font-bold">Welcome to FiBuKI</h1>
        <p className="text-muted-foreground">
          How do you want to use your banking data?
        </p>
      </div>

      {/* Track cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {tracks.map((track) => {
          const isSelected = selected === track.id;
          return (
            <Card
              key={track.id}
              className={cn(
                "cursor-pointer transition-all duration-200",
                "hover:border-primary/50 hover:shadow-md",
                isSelected && "border-primary ring-2 ring-primary/20 shadow-md"
              )}
              onClick={() => setSelected(track.id)}
            >
              <CardContent className="p-6 space-y-4">
                <div className="flex items-start justify-between">
                  <div className={cn(
                    "p-2.5 rounded-lg",
                    isSelected ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"
                  )}>
                    <track.icon className="h-6 w-6" />
                  </div>
                  {isSelected && (
                    <div className="h-6 w-6 rounded-full bg-primary flex items-center justify-center animate-in zoom-in duration-200">
                      <Check className="h-3.5 w-3.5 text-primary-foreground" />
                    </div>
                  )}
                </div>

                <div>
                  <h2 className="text-lg font-semibold">{track.title}</h2>
                  <p className="text-sm text-muted-foreground">{track.subtitle}</p>
                </div>

                <p className="text-sm text-muted-foreground">{track.description}</p>

                <ul className="space-y-1.5">
                  {track.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2 text-sm">
                      <Check className="h-3.5 w-3.5 text-green-600 mt-0.5 shrink-0" />
                      <span>{feature}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          );
        })}
      </div>

      {/* Confirm button + footer */}
      <div className="flex flex-col items-center gap-3">
        <Button
          size="lg"
          onClick={handleConfirm}
          disabled={!selected || submitting}
          className="min-w-[200px]"
        >
          {submitting ? "Setting up..." : "Continue"}
        </Button>
        <p className="text-xs text-muted-foreground">
          You can change this later in Settings
        </p>
      </div>
    </div>
  );
}
