"use client";

import { useTranslations } from "next-intl";
import { ToolPreviewCard } from "./tool-preview-card";
import { Landmark, Sparkles, Terminal } from "lucide-react";
import Image from "next/image";
import { useRef, useCallback, type PointerEvent as ReactPointerEvent } from "react";

const FLOATING_LOGOS = [
  { src: "/logos/claude_logo.png", alt: "Claude" },
  { src: "/logos/openclaw_logo.avif", alt: "OpenClaw" },
  { src: "/logos/openai_logo.png", alt: "OpenAI" },
];

function useDraggable() {
  const ref = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const start = useRef({ x: 0, y: 0 });
  const offset = useRef({ x: 0, y: 0 });

  const onPointerDown = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const el = ref.current;
    if (!el) return;
    dragging.current = true;
    start.current = { x: e.clientX - offset.current.x, y: e.clientY - offset.current.y };
    el.setPointerCapture(e.pointerId);
    el.style.transition = "none";
    el.style.cursor = "grabbing";
  }, []);

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragging.current || !ref.current) return;
    offset.current = {
      x: e.clientX - start.current.x,
      y: e.clientY - start.current.y,
    };
    ref.current.style.transform = `translate(${offset.current.x}px, ${offset.current.y}px)`;
  }, []);

  const onPointerUp = useCallback(() => {
    if (!dragging.current || !ref.current) return;
    dragging.current = false;
    offset.current = { x: 0, y: 0 };
    ref.current.style.transition = "transform 0.6s cubic-bezier(0.22, 1.8, 0.36, 1)";
    ref.current.style.transform = "translate(0px, 0px)";
    ref.current.style.cursor = "grab";
  }, []);

  return { ref, onPointerDown, onPointerMove, onPointerUp };
}

function DraggableCard({ children }: { children: React.ReactNode }) {
  const { ref, onPointerDown, onPointerMove, onPointerUp } = useDraggable();

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      className="cursor-grab select-none touch-none"
    >
      {children}
    </div>
  );
}

export function ToolPreviewSection() {
  const t = useTranslations("landing.toolPreviews");

  return (
    <div className="mt-12 grid grid-cols-1 md:grid-cols-3 gap-6 max-w-5xl w-full px-4">
      {/* Live Bank Data */}
      <DraggableCard>
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Landmark className="h-4 w-4" />
            <span>{t("transactions.title")}</span>
          </div>
          <ToolPreviewCard type="transactions" />
        </div>
      </DraggableCard>

      {/* AI-First Matching */}
      <DraggableCard>
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Sparkles className="h-4 w-4" />
            <span>{t("files.title")}</span>
          </div>
          <ToolPreviewCard type="files" />
        </div>
      </DraggableCard>

      {/* MCP & API */}
      <DraggableCard>
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Terminal className="h-4 w-4" />
            <span>{t("integrations.title")}</span>
          </div>
          <ToolPreviewCard type="api" />
          <div className="flex justify-between items-start mt-3 px-1">
            {FLOATING_LOGOS.map((logo) => (
              <div
                key={logo.alt}
                className="bg-white rounded-lg border border-zinc-200 shadow-md px-2 py-1"
              >
                <Image
                  src={logo.src}
                  alt={logo.alt}
                  width={80}
                  height={22}
                  className="h-4 w-auto"
                />
              </div>
            ))}
          </div>
        </div>
      </DraggableCard>
    </div>
  );
}
