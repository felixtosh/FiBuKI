"use client";

import { useRef, useMemo } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { InvestmentTrade } from "@/types/investment-trade";
import { TradeTypeBadge } from "./trade-type-badge";
import { formatCurrency, toDateSafe } from "@/lib/utils";
import { format } from "date-fns";
import { ArrowUpRight, ArrowDownRight } from "lucide-react";

interface TradeTableProps {
  trades: InvestmentTrade[];
}

export function TradeTable({ trades }: TradeTableProps) {
  const parentRef = useRef<HTMLDivElement>(null);

  const sortedTrades = useMemo(
    () => [...trades].sort((a, b) => {
      const da = toDateSafe(a.date) ?? new Date(0);
      const db = toDateSafe(b.date) ?? new Date(0);
      return db.getTime() - da.getTime();
    }),
    [trades]
  );

  const virtualizer = useVirtualizer({
    count: sortedTrades.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 52,
    overscan: 20,
  });

  if (trades.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        No trades imported yet. Import a broker CSV to get started.
      </div>
    );
  }

  return (
    <div>
      {/* Header */}
      <div className="grid grid-cols-[100px_80px_1fr_100px_120px_120px_120px] gap-2 px-4 py-2 text-xs font-medium text-muted-foreground border-b sticky top-0 bg-background z-10">
        <div>Date</div>
        <div>Type</div>
        <div>Asset</div>
        <div className="text-right">Qty</div>
        <div className="text-right">Price</div>
        <div className="text-right">Amount</div>
        <div className="text-right">Gain/Loss</div>
      </div>

      {/* Virtual scroll container */}
      <div ref={parentRef} className="overflow-auto" style={{ maxHeight: "calc(100vh - 300px)" }}>
        <div style={{ height: `${virtualizer.getTotalSize()}px`, position: "relative" }}>
          {virtualizer.getVirtualItems().map((virtualRow) => {
            const trade = sortedTrades[virtualRow.index];
            const tradeDate = toDateSafe(trade.date);
            const hasGain = trade.tradeType === "sell" && trade.realizedGainEur != null;
            const gain = trade.realizedGainEur ?? 0;

            return (
              <div
                key={trade.id}
                data-index={virtualRow.index}
                ref={virtualizer.measureElement}
                className="grid grid-cols-[100px_80px_1fr_100px_120px_120px_120px] gap-2 px-4 py-2.5 border-b hover:bg-muted/50 items-center"
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                <div className="text-sm tabular-nums">
                  {tradeDate ? format(tradeDate, "dd.MM.yy") : "—"}
                </div>
                <div>
                  <TradeTypeBadge tradeType={trade.tradeType} />
                </div>
                <div className="min-w-0">
                  <div className="text-sm font-medium truncate">{trade.ticker}</div>
                  <div className="text-xs text-muted-foreground truncate">{trade.assetName}</div>
                </div>
                <div className="text-sm text-right tabular-nums">
                  {trade.quantity.toLocaleString("de-AT", { maximumFractionDigits: 4 })}
                </div>
                <div className="text-sm text-right tabular-nums">
                  {formatCurrency(trade.pricePerUnit, trade.currency)}
                </div>
                <div className="text-sm text-right tabular-nums font-medium">
                  {formatCurrency(trade.netAmount, trade.currency)}
                </div>
                <div className="text-sm text-right tabular-nums">
                  {hasGain ? (
                    <span className={`flex items-center justify-end gap-0.5 ${gain >= 0 ? "text-green-600" : "text-red-600"}`}>
                      {gain >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                      {formatCurrency(Math.abs(gain), "EUR")}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
