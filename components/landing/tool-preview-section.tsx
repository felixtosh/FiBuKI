"use client";

import { useTranslations } from "next-intl";
import { ToolPreviewCard } from "./tool-preview-card";
import { Landmark, Sparkles, Terminal } from "lucide-react";
import Image from "next/image";

const FLOATING_LOGOS = [
  {
    src: "/logos/claude_logo.png",
    alt: "Claude",
  },
  {
    src: "/logos/openclaw_logo.avif",
    alt: "OpenClaw",
  },
  {
    src: "/logos/openai_logo.png",
    alt: "OpenAI",
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
        <div>
          <ToolPreviewCard type="api" />
          <div className="flex justify-between items-start mt-3 px-1">
            {FLOATING_LOGOS.map((logo, i) => (
              <div
                key={logo.alt}
                className={
                  i === 0
                    ? "animate-float-slow"
                    : i === 1
                      ? "animate-float-medium"
                      : "animate-float-fast"
                }
              >
                <div className="bg-white rounded-lg border border-zinc-200 shadow-md px-2 py-1">
                  <Image
                    src={logo.src}
                    alt={logo.alt}
                    width={80}
                    height={22}
                    className="h-4 w-auto"
                  />
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
