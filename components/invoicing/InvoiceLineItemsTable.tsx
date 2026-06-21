"use client";

import { useCallback } from "react";
import { GripVertical, Plus, Trash2 } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { InvoiceLineItem, computeLineItemTotals, DEFAULT_VAT_RATE } from "@/types/invoice";
import { cn } from "@/lib/utils";

interface InvoiceLineItemsTableProps {
  lineItems: InvoiceLineItem[];
  onChange: (lineItems: InvoiceLineItem[]) => void;
  disabled?: boolean;
}

function formatEur(cents: number): string {
  const safe = Math.round(cents);
  const negative = safe < 0;
  const abs = Math.abs(safe);
  const euros = Math.floor(abs / 100);
  const remainder = abs % 100;
  const eurosStr = euros.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}${eurosStr},${String(remainder).padStart(2, "0")} €`;
}

function generateId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `li_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/**
 * Line items editor. Uses container queries (the parent
 * `.detail-panel-container` sets `container-type: inline-size`) to switch
 * between a stacked card layout on narrow widths and an inline 5-column grid
 * once the panel is wide enough. Threshold (~560px) chosen against the
 * default 600px panel width minus editor padding.
 *
 * Layout strategy: the row markup is a stacked card by default. When the
 * container is wide enough, a global CSS rule (`.invoice-line-items-row`
 * inside `@container (min-width: 560px)`) flips the row into a CSS grid
 * with `display: contents` on the inner wrappers — letting their children
 * flow as direct grid items.
 */
export function InvoiceLineItemsTable({
  lineItems,
  onChange,
  disabled = false,
}: InvoiceLineItemsTableProps) {
  const updateItem = useCallback(
    (index: number, patch: Partial<InvoiceLineItem>) => {
      const next = lineItems.map((item, i) =>
        i === index ? { ...item, ...patch } : item
      );
      onChange(next);
    },
    [lineItems, onChange]
  );

  const removeItem = useCallback(
    (index: number) => {
      // Always keep at least one row — issueInvoice requires it, and an empty
      // editor with no rows is a worse UX than one blank row.
      if (lineItems.length <= 1) {
        onChange([
          {
            id: lineItems[0]?.id ?? generateId(),
            description: "",
            quantity: 1,
            unitPrice: 0,
            vatRate: DEFAULT_VAT_RATE,
          },
        ]);
        return;
      }
      const next = lineItems.filter((_, i) => i !== index);
      onChange(next);
    },
    [lineItems, onChange]
  );

  const addItem = useCallback(() => {
    const next: InvoiceLineItem[] = [
      ...lineItems,
      {
        id: generateId(),
        description: "",
        quantity: 1,
        unitPrice: 0,
        vatRate: DEFAULT_VAT_RATE,
      },
    ];
    onChange(next);
  }, [lineItems, onChange]);

  return (
    <div className="space-y-2 invoice-line-items">
      {/* Header — only visible in wide (inline grid) mode (see globals.css). */}
      <div
        className={cn(
          "hidden grid-cols-[20px_minmax(0,1fr)_70px_110px_70px_110px_28px] gap-2",
          "text-xs font-medium text-muted-foreground px-1",
          "invoice-line-items-header-wide"
        )}
      >
        <span />
        <span>Beschreibung</span>
        <span className="text-right">Menge</span>
        <span className="text-right">Einzelpreis (€)</span>
        <span className="text-right">USt. %</span>
        <span className="text-right">Gesamt</span>
        <span />
      </div>

      <div className="space-y-2 invoice-line-items-rows">
        {lineItems.length === 0 ? (
          <div className="text-sm text-muted-foreground py-4 text-center border border-dashed rounded-md">
            Keine Positionen
          </div>
        ) : (
          lineItems.map((item, index) => {
            const { netCents } = computeLineItemTotals(item);
            const unitEur =
              item.unitPrice === 0 ? "" : (item.unitPrice / 100).toString();
            return (
              <LineItemRow
                key={item.id}
                item={item}
                unitEur={unitEur}
                netCents={netCents}
                disabled={disabled}
                canRemove={lineItems.length > 1}
                onUpdate={(patch) => updateItem(index, patch)}
                onRemove={() => removeItem(index)}
              />
            );
          })
        )}
      </div>

      <div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={addItem}
          disabled={disabled}
        >
          <Plus className="h-3.5 w-3.5 mr-1.5" />
          Position hinzufügen
        </Button>
      </div>
    </div>
  );
}

interface LineItemRowProps {
  item: InvoiceLineItem;
  unitEur: string;
  netCents: number;
  disabled: boolean;
  /** When false the remove button is hidden (e.g. the only line item). */
  canRemove: boolean;
  onUpdate: (patch: Partial<InvoiceLineItem>) => void;
  onRemove: () => void;
}

function LineItemRow({
  item,
  unitEur,
  netCents,
  disabled,
  canRemove,
  onUpdate,
  onRemove,
}: LineItemRowProps) {
  return (
    <div className="rounded-md border bg-card/50 p-3 space-y-2 invoice-line-items-row">
      {/* Grip handle (hidden in narrow / shown in wide). */}
      <div
        className="hidden text-muted-foreground items-center justify-center cursor-grab invoice-line-items-grip"
        aria-hidden
      >
        <GripVertical className="h-4 w-4" />
      </div>

      {/* Description */}
      <div className="invoice-line-items-cell invoice-line-items-cell-description">
        <Label className="invoice-line-items-label text-xs text-muted-foreground">
          Beschreibung
        </Label>
        <Input
          value={item.description}
          onChange={(e) => onUpdate({ description: e.target.value })}
          placeholder="Beschreibung"
          disabled={disabled}
          className="h-8"
        />
      </div>

      {/* Numerics: in narrow mode this is a 3-col grid; in wide mode each
          cell flows directly into the parent grid via display:contents. */}
      <div className="grid grid-cols-3 gap-2 invoice-line-items-numerics">
        <div className="invoice-line-items-cell">
          <Label className="invoice-line-items-label text-xs text-muted-foreground">
            Menge
          </Label>
          <Input
            type="number"
            inputMode="decimal"
            value={item.quantity}
            min={0}
            step={1}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              onUpdate({ quantity: Number.isFinite(v) ? v : 0 });
            }}
            disabled={disabled}
            className="h-8 text-right"
          />
        </div>
        <div className="invoice-line-items-cell">
          <Label className="invoice-line-items-label text-xs text-muted-foreground">
            Einzelpreis (€)
          </Label>
          <Input
            type="number"
            inputMode="decimal"
            value={unitEur}
            step="0.01"
            min={0}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === "") {
                onUpdate({ unitPrice: 0 });
                return;
              }
              const eur = parseFloat(raw);
              if (!Number.isFinite(eur)) return;
              onUpdate({ unitPrice: Math.round(eur * 100) });
            }}
            disabled={disabled}
            className="h-8 text-right"
          />
        </div>
        <div className="invoice-line-items-cell">
          <Label className="invoice-line-items-label text-xs text-muted-foreground">
            USt. %
          </Label>
          <Input
            type="number"
            inputMode="decimal"
            value={item.vatRate}
            step={1}
            min={0}
            max={100}
            onChange={(e) => {
              const v = parseFloat(e.target.value);
              onUpdate({ vatRate: Number.isFinite(v) ? v : 0 });
            }}
            disabled={disabled}
            className="h-8 text-right"
          />
        </div>
      </div>

      {/* Footer: gesamt + remove (display:contents in wide mode). */}
      <div className="flex items-center justify-between gap-2 invoice-line-items-footer">
        <span className="text-xs text-muted-foreground invoice-line-items-label">
          Gesamt
        </span>
        <div className="flex items-center gap-1 invoice-line-items-footer-actions">
          <div className="text-sm tabular-nums px-1 invoice-line-items-total">
            {formatEur(netCents)}
          </div>
          {canRemove && (
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-7 invoice-line-items-remove"
              onClick={onRemove}
              disabled={disabled}
              title="Position entfernen"
            >
              <Trash2 className="h-4 w-4 text-muted-foreground" />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
