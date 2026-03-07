"use client";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Sparkles } from "lucide-react";
import type { PlanFeatureKey } from "@/types/billing";
import { useRouter } from "next/navigation";

const FEATURE_LABELS: Record<PlanFeatureKey, { title: string; description: string; minPlan: string }> = {
  fileUpload: {
    title: "File Upload",
    description: "Upload receipts and invoices to match with transactions.",
    minPlan: "Smart",
  },
  aiMatching: {
    title: "AI Matching",
    description: "Automatically match files to transactions with AI.",
    minPlan: "Smart",
  },
  aiExtraction: {
    title: "AI Extraction",
    description: "Extract data from receipts and invoices automatically.",
    minPlan: "Smart",
  },
  gmailIntegration: {
    title: "Gmail Integration",
    description: "Import invoices directly from your Gmail inbox.",
    minPlan: "Smart",
  },
  partnerIntelligence: {
    title: "Partner Intelligence",
    description: "AI-powered partner matching and behavioral insights.",
    minPlan: "Smart",
  },
  chatAssistant: {
    title: "Chat Assistant",
    description: "Ask questions about your transactions and get AI-powered answers.",
    minPlan: "Smart",
  },
  apiAccess: {
    title: "API Access",
    description: "Access your banking data programmatically via REST API.",
    minPlan: "Data",
  },
  mcpAccess: {
    title: "MCP Access",
    description: "Connect to Claude, ChatGPT, and other AI tools via MCP.",
    minPlan: "Data",
  },
  bmdExport: {
    title: "BMD Export",
    description: "Export transactions in BMD/NTCS format for your tax advisor.",
    minPlan: "Pro",
  },
};

interface UpgradePromptDialogProps {
  feature: PlanFeatureKey;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function UpgradePromptDialog({
  feature,
  open,
  onOpenChange,
}: UpgradePromptDialogProps) {
  const router = useRouter();
  const info = FEATURE_LABELS[feature];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-yellow-500" />
            Upgrade to {info.minPlan}
          </DialogTitle>
          <DialogDescription>{info.description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-4 pt-2">
          <p className="text-sm text-muted-foreground">
            <strong>{info.title}</strong> requires the{" "}
            <strong>{info.minPlan}</strong> plan or higher.
          </p>
          <div className="flex gap-2 justify-end">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Maybe later
            </Button>
            <Button onClick={() => router.push("/settings/billing")}>
              View Plans
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
