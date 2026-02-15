"use client";

import { cn } from "@/lib/utils";
import {
  FileCheck,
  FileX,
  FileText,
  Mail,
  Check,
  Paperclip,
  Globe,
} from "lucide-react";

type ToolType = "transactions" | "files" | "integrations";

interface ToolPreviewCardProps {
  type: ToolType;
  className?: string;
}

// Fake data for previews
const FAKE_TRANSACTIONS = [
  {
    date: "15.01.2026",
    name: "REWE Markt",
    partner: "REWE Group",
    amount: -4523,
    hasReceipt: true,
  },
  {
    date: "14.01.2026",
    name: "Amazon.de",
    partner: "Amazon EU",
    amount: -12999,
    hasReceipt: true,
  },
  {
    date: "13.01.2026",
    name: "Gehalt Januar",
    partner: "Arbeitgeber GmbH",
    amount: 350000,
    hasReceipt: false,
  },
];

const FAKE_FILES = [
  {
    name: "Rechnung_2026_001.pdf",
    partner: "REWE Group",
    status: "connected",
  },
  {
    name: "Amazon_Invoice.pdf",
    partner: "Amazon EU",
    status: "connected",
  },
  {
    name: "Telefonrechnung.pdf",
    partner: "Telekom",
    status: "matching",
  },
];

const FAKE_GMAIL = [
  { filename: "Invoice_2026_01.pdf", score: 92 },
  { filename: "Rechnung_Amazon.pdf", score: 85 },
];

const FAKE_BROWSER = [
  { filename: "Bestellung_Download.pdf", score: 88 },
  { filename: "Kaufbeleg_Online.pdf", score: 76 },
];

export function ToolPreviewCard({ type, className }: ToolPreviewCardProps) {
  const formatAmount = (amount: number) => {
    const euros = amount / 100;
    return euros.toLocaleString("de-DE", { style: "currency", currency: "EUR" });
  };

  if (type === "transactions") {
    return (
      <div
        className={cn(
          "rounded-md border text-xs overflow-hidden bg-card shadow-lg",
          className
        )}
      >
        <div className="bg-muted/50 grid grid-cols-[auto_1fr_auto_auto] gap-2 px-2 py-1.5 border-b">
          <span className="font-medium text-muted-foreground w-[70px]">
            Date
          </span>
          <span className="font-medium text-muted-foreground">Name</span>
          <span className="font-medium text-muted-foreground text-right w-[80px]">
            Amount
          </span>
          <span className="w-5"></span>
        </div>
        <div className="divide-y divide-muted/50">
          {FAKE_TRANSACTIONS.map((t, i) => (
            <div
              key={i}
              className="grid grid-cols-[auto_1fr_auto_auto] gap-2 px-2 py-2 items-center"
            >
              <span className="text-muted-foreground w-[70px]">{t.date}</span>
              <div className="min-w-0 overflow-hidden">
                <span className="truncate block">{t.name}</span>
                <span className="text-[10px] text-muted-foreground truncate block">
                  {t.partner}
                </span>
              </div>
              <span
                className={cn(
                  "text-right tabular-nums w-[80px]",
                  t.amount < 0 ? "text-amount-negative" : "text-amount-positive"
                )}
              >
                {formatAmount(t.amount)}
              </span>
              <div className="w-5 flex justify-center">
                {t.hasReceipt ? (
                  <FileCheck className="h-3.5 w-3.5 text-green-600" />
                ) : (
                  <FileX className="h-3.5 w-3.5 text-muted-foreground/50" />
                )}
              </div>
            </div>
          ))}
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
        <div className="bg-muted/50 grid grid-cols-[1fr_auto] gap-2 px-2 py-1.5 border-b">
          <span className="font-medium text-muted-foreground">Receipt</span>
          <span className="font-medium text-muted-foreground">Status</span>
        </div>
        <div className="divide-y divide-muted/50">
          {FAKE_FILES.map((f, i) => (
            <div
              key={i}
              className="grid grid-cols-[1fr_auto] gap-2 px-2 py-2 items-center"
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
              <span
                className={cn(
                  "text-[10px] px-1.5 py-0.5 rounded-full",
                  f.status === "connected"
                    ? "bg-green-50 text-green-900 border border-green-300"
                    : "bg-amber-50 text-amber-900 border border-amber-300"
                )}
              >
                {f.status === "connected" ? "Connected" : "Matching..."}
              </span>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // Integrations type - overlapping Gmail and Browser cards
  return (
    <div className={cn("relative h-[160px]", className)}>
      {/* Gmail card - back */}
      <div className="absolute top-0 left-0 right-6 rounded-md border text-xs overflow-hidden bg-card shadow-lg">
        <div className="bg-muted/50 px-3 py-1.5 flex items-center gap-2 border-b">
          <Mail className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium text-sm">Gmail</span>
        </div>
        <div className="divide-y divide-muted/50">
          {FAKE_GMAIL.map((e, i) => (
            <div key={i} className="flex items-center gap-2 px-2.5 py-1.5">
              <Paperclip className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="text-xs truncate flex-1">{e.filename}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-50 text-green-900">
                {e.score}%
              </span>
            </div>
          ))}
        </div>
      </div>

      {/* Browser card - front */}
      <div className="absolute top-12 left-6 right-0 rounded-md border text-xs overflow-hidden bg-card shadow-xl">
        <div className="bg-muted/50 px-3 py-1.5 flex items-center gap-2 border-b">
          <Globe className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium text-sm">Browser Downloads</span>
        </div>
        <div className="divide-y divide-muted/50">
          {FAKE_BROWSER.map((e, i) => (
            <div key={i} className="flex items-center gap-2 px-2.5 py-1.5">
              <FileText className="h-3 w-3 text-muted-foreground shrink-0" />
              <span className="text-xs truncate flex-1">{e.filename}</span>
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-green-50 text-green-900">
                {e.score}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
