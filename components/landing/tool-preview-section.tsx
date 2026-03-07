"use client";

import { useTranslations } from "next-intl";
import { ToolPreviewCard } from "./tool-preview-card";
import { Landmark, Sparkles, Terminal } from "lucide-react";
import Image from "next/image";

const FLOATING_LOGOS = [
  {
    src: "/logos/claude_logo.png",
    alt: "Claude",
    position: "absolute -top-6 left-1/4 animate-float-slow",
    width: 100,
    height: 28,
  },
  {
    src: "/logos/openai_logo.png",
    alt: "OpenAI",
    position: "absolute -bottom-6 left-2 animate-float-medium",
    width: 100,
    height: 28,
  },
  {
    src: "/logos/openclaw_logo.avif",
    alt: "OpenClaw",
    position: "absolute top-1/3 -right-12 animate-float-fast",
    width: 100,
    height: 28,
  },
];

export function ToolPreviewSection() {
  const t = useTranslations("landing.toolPreviews");

  return (
    <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl w-full px-4">
      {/* Live Bank Data */}
      <div className="space-y-3 animate-float-slow">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Landmark className="h-4 w-4" />
          <span>{t("transactions.title")}</span>
        </div>
        <ToolPreviewCard type="transactions" />
      </div>

      {/* AI-First Matching */}
      <div className="space-y-3 animate-float-medium">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Sparkles className="h-4 w-4" />
          <span>{t("files.title")}</span>
        </div>
        <ToolPreviewCard type="files" />
      </div>

      {/* MCP & API */}
      <div className="space-y-3 animate-float-fast">
        <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Terminal className="h-4 w-4" />
          <span>{t("integrations.title")}</span>
        </div>
        <div className="relative">
          <ToolPreviewCard type="api" />
          {FLOATING_LOGOS.map((logo) => (
            <div key={logo.alt} className={logo.position}>
              <div className="bg-white rounded-lg border border-zinc-200 shadow-md px-2.5 py-1.5">
                <Image
                  src={logo.src}
                  alt={logo.alt}
                  width={logo.width}
                  height={logo.height}
                  className="h-5 w-auto"
                />
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
