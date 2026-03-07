"use client";

import { cn } from "@/lib/utils";
import {
  FileCheck,
  FileText,
  Bot,
  ChevronRight,
} from "lucide-react";

type ToolType = "api" | "files" | "integrations";

interface ToolPreviewCardProps {
  type: ToolType;
  className?: string;
}

// Fake data for API preview
const FAKE_MCP_CALL = {
  tool: "list_transactions",
  params: '{ "limit": 3, "source": "raiffeisen" }',
  result: [
    { date: "2026-01-15", name: "REWE Markt", amount: "-45.23" },
    { date: "2026-01-14", name: "Amazon.de", amount: "-129.99" },
    { date: "2026-01-13", name: "Gehalt", amount: "+3,500.00" },
  ],
};

const FAKE_FILES = [
  {
    name: "Rechnung_2026_001.pdf",
    partner: "REWE Group",
    status: "connected" as const,
    confidence: 96,
  },
  {
    name: "Amazon_Invoice.pdf",
    partner: "Amazon EU",
    status: "connected" as const,
    confidence: 92,
  },
  {
    name: "Telefonrechnung.pdf",
    partner: "Telekom",
    status: "matching" as const,
    confidence: 78,
  },
];

const AI_SERVICES = [
  { name: "Claude", sub: "via MCP" },
  { name: "ChatGPT", sub: "via API" },
  { name: "Claude Code", sub: "via MCP" },
  { name: "OpenClaw", sub: "via MCP" },
];

export function ToolPreviewCard({ type, className }: ToolPreviewCardProps) {
  if (type === "api") {
    return (
      <div
        className={cn(
          "rounded-md border text-xs overflow-hidden bg-card shadow-lg font-mono",
          className
        )}
      >
        {/* Terminal header */}
        <div className="bg-zinc-900 text-zinc-400 px-3 py-1.5 flex items-center gap-2 border-b border-zinc-700">
          <div className="flex gap-1.5">
            <div className="w-2.5 h-2.5 rounded-full bg-red-500/80" />
            <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/80" />
            <div className="w-2.5 h-2.5 rounded-full bg-green-500/80" />
          </div>
          <span className="text-[10px] text-zinc-500 ml-1">MCP Tool Call</span>
        </div>
        {/* Tool call */}
        <div className="bg-zinc-950 text-zinc-300 px-3 py-2 space-y-1.5">
          <div>
            <span className="text-blue-400">{FAKE_MCP_CALL.tool}</span>
            <span className="text-zinc-500">(</span>
            <span className="text-emerald-400">{FAKE_MCP_CALL.params}</span>
            <span className="text-zinc-500">)</span>
          </div>
          <div className="border-t border-zinc-800 pt-1.5">
            {FAKE_MCP_CALL.result.map((r, i) => (
              <div key={i} className="flex justify-between text-[10px] py-0.5">
                <span className="text-zinc-500">{r.date}</span>
                <span className="text-zinc-300 truncate mx-2 flex-1">{r.name}</span>
                <span className={r.amount.startsWith("+") ? "text-emerald-400" : "text-red-400"}>
                  {r.amount} EUR
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (type === "files") {
    return (
      <div
        className={cn(
          "rounded-md border text-xs overflow-hidden bg-card shadow-lg",
          className
        )}
      >
        <div className="bg-muted/50 grid grid-cols-[1fr_auto_auto] gap-2 px-2 py-1.5 border-b">
          <span className="font-medium text-muted-foreground">Receipt</span>
          <span className="font-medium text-muted-foreground">Score</span>
          <span className="font-medium text-muted-foreground">Status</span>
        </div>
        <div className="divide-y divide-muted/50">
          {FAKE_FILES.map((f, i) => (
            <div
              key={i}
              className="grid grid-cols-[1fr_auto_auto] gap-2 px-2 py-2 items-center"
            >
              <div className="min-w-0 overflow-hidden flex items-center gap-2">
                <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <div className="min-w-0">
                  <span className="truncate block">{f.name}</span>
                  <span className="text-[10px] text-muted-foreground truncate block">
                    {f.partner}
                  </span>
                </div>
              </div>
              <span className={cn(
                "text-[10px] tabular-nums font-medium",
                f.confidence >= 90 ? "text-green-600" : f.confidence >= 80 ? "text-amber-600" : "text-muted-foreground"
              )}>
                {f.confidence}%
              </span>
              <span
                className={cn(
                  "text-[10px] px-1.5 py-0.5 rounded-full",
                  f.status === "connected"
                    ? "bg-green-50 text-green-900 border border-green-300"
                    : "bg-amber-50 text-amber-900 border border-amber-300"
                )}
              >
                {f.status === "connected" ? (
                  <span className="flex items-center gap-0.5">
                    <FileCheck className="h-2.5 w-2.5" /> Matched
                  </span>
                ) : "Matching..."}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Integrations type - AI service logos
  return (
    <div className={cn("rounded-md border text-xs overflow-hidden bg-card shadow-lg", className)}>
      <div className="bg-muted/50 px-3 py-1.5 border-b">
        <span className="font-medium text-muted-foreground">Connected AI Services</span>
      </div>
      <div className="divide-y divide-muted/50">
        {AI_SERVICES.map((s, i) => (
          <div key={i} className="flex items-center gap-2 px-3 py-2">
            <Bot className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
            <div className="flex-1 min-w-0">
              <span className="text-xs font-medium">{s.name}</span>
              <span className="text-[10px] text-muted-foreground ml-1.5">{s.sub}</span>
            </div>
            <ChevronRight className="h-3 w-3 text-muted-foreground/50" />
          </div>
        ))}
      </div>
    </div>
  );
}
