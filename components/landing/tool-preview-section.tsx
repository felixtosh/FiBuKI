"use client";

import { useTranslations } from "next-intl";
import { ToolPreviewCard } from "./tool-preview-card";
import { Terminal, Sparkles, Plug } from "lucide-react";

export function ToolPreviewSection() {
  const t = useTranslations("landing.toolPreviews");

  return (
    <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl w-full px-4">
      {/* Bank Data API Preview */}
      <div className="space-y-3 animate-float-slow">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Terminal className="h-4 w-4" />
          <span>{t("transactions.title")}</span>
        </div>
        <ToolPreviewCard type="api" />
      </div>

      {/* AI Matching Preview */}
      <div className="space-y-3 animate-float-medium">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Sparkles className="h-4 w-4" />
          <span>{t("files.title")}</span>
        </div>
        <ToolPreviewCard type="files" />
      </div>

      {/* Integrations Preview */}
      <div className="space-y-3 animate-float-fast">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Plug className="h-4 w-4" />
          <span>{t("integrations.title")}</span>
        </div>
        <ToolPreviewCard type="integrations" />
      </div>
    </div>
  );
}
