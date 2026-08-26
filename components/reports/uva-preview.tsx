"use client";

/**
 * UVA figure sheet (fork #64): renders the per-Kennzahl result of the
 * server-side calculation, plus the provenance lists the spec makes
 * first-class — the unresolved bucket (the receipt-chasing worklist),
 * the foreign-VAT tag list and the reverse-charge list. This replaces
 * the old preview whose KZ labels encoded the broken hand-mapping
 * (KZ000 as the 20% line, fabricated KZ096, swapped 10%/13%).
 */

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { ReportPeriod, formatPeriod } from "@/types/report";
import { TaxCountryCode } from "@/types/user-data";
import type { UvaReportResult } from "@/functions/src/uva/types";

interface UVAPreviewProps {
  result: UvaReportResult;
  period: ReportPeriod;
  country: TaxCountryCode;
}

function formatAmount(cents: number): string {
  return (cents / 100).toLocaleString("de-AT", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

/** Labels per Kennzahl, verified against the official U30 form 2026. */
const KZ_LABELS: Record<string, string> = {
  "000": "Total supplies (net, all rates incl. exempt)",
  "022": "Taxable at 20% (net base)",
  "029": "Taxable at 10% (net base)",
  "006": "Taxable at 13% (net base)",
  "124": "Taxable at 4.9% (net base)",
  "011": "Export deliveries (Ausfuhrlieferungen)",
  "017": "EU deliveries (innergemeinschaftliche Lieferungen)",
  "057": "Reverse charge received — output VAT (§19)",
  "066": "Reverse charge received — input VAT",
  "070": "EU acquisitions (total net base)",
  "072": "EU acquisitions taxable at 20% (base)",
  "073": "EU acquisitions taxable at 10% (base)",
  "008": "EU acquisitions taxable at 13% (base)",
  "125": "EU acquisitions taxable at 4.9% (base)",
  "065": "Input VAT from EU acquisitions",
  "060": "Input VAT from invoices (Vorsteuer)",
  "061": "Import VAT paid (Einfuhrumsatzsteuer)",
  "083": "Import VAT via §26 (EUSt deferral)",
  "095": "Zahllast / Gutschrift (netted)",
};

const KZ_ORDER = [
  "000", "022", "029", "006", "124", "011", "017",
  "057", "070", "072", "073", "008", "125",
  "060", "066", "065", "061", "083",
  "095",
];

const STEP_LABELS: Record<string, string> = {
  "line-items": "from line items",
  "top-level": "from receipt totals",
  override: "manual override",
  invoice: "from outgoing invoice",
  "defaulted-20": "DEFAULTED to 20%",
  "exempt-class": "exempt class",
  "non-claimable": "not claimable — excluded",
  "reverse-charge": "reverse charge",
  "eu-acquisition": "EU acquisition",
  import: "import",
};

/** Why a document's VAT was kept out of Vorsteuer (#203). */
const NON_CLAIMABLE_LABELS: Record<string, string> = {
  "insurance-tax": "Versicherungssteuer — insurance is VAT-exempt",
  levy: "Public levy printed in the VAT column",
  "discount-to-zero": "100% discount — nothing due",
  private: "Private consumption",
};

const REASON_LABELS: Record<string, string> = {
  "no-file": "No receipt connected",
  "no-vat-data": "Receipt has no VAT data",
  "foreign-or-invalid-rate": "Foreign or invalid VAT rate",
  "amount-mismatch": "Bank amount ≠ invoice total",
  "foreign-currency": "Foreign-currency receipt — no usable exchange rate",
  "needs-receipt": "Receipt lost — needs documentation",
};

function KennzahlRow({
  kz,
  label,
  amount,
  provenance,
  isTotal = false,
}: {
  kz: string;
  label: string;
  amount: number;
  provenance?: string;
  isTotal?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-4 py-2 px-3 rounded",
        isTotal && "bg-muted font-semibold"
      )}
    >
      <span className="w-16 font-mono text-xs text-muted-foreground">KZ {kz}</span>
      <span className="flex-1 text-sm">
        {label}
        {provenance && (
          <span className="ml-2 text-xs text-muted-foreground">({provenance})</span>
        )}
      </span>
      <span
        className={cn(
          "font-mono text-sm tabular-nums",
          isTotal && (amount > 0 ? "text-amount-negative" : "text-amount-positive")
        )}
      >
        {formatAmount(amount)} EUR
      </span>
    </div>
  );
}

export function UVAPreview({ result, period, country }: UVAPreviewProps) {
  const codes = KZ_ORDER.filter(
    (code) => result.kennzahlen[code] && (result.kennzahlen[code].value !== 0 || code === "095")
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>UVA Figure Sheet</CardTitle>
              <CardDescription>
                Umsatzsteuervoranmeldung for {formatPeriod(period)} — rates in force:{" "}
                {result.period.rateSet.filter((r) => r > 0).join("% / ")}%
              </CardDescription>
            </div>
            <Badge variant="outline">{country}</Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            {codes.map((code) => {
              const figure = result.kennzahlen[code];
              const provenance = Object.entries(figure.contributions)
                .map(([step, n]) => `${n}× ${STEP_LABELS[step] ?? step}`)
                .join(", ");
              return (
                <KennzahlRow
                  key={code}
                  kz={code}
                  label={KZ_LABELS[code] ?? "—"}
                  amount={figure.value}
                  provenance={provenance || undefined}
                  isTotal={code === "095"}
                />
              );
            })}
          </div>

          {result.euKennzahlen.basis === "not-implemented" && (
            <p className="text-xs text-muted-foreground px-3">
              EU Kennzahlen: automatic detection not implemented — absence of EU
              figures is not a measurement.
            </p>
          )}

          <Separator />

          <div
            className={cn(
              "p-4 rounded-lg text-center",
              result.balance >= 0
                ? "bg-red-50 border border-red-200"
                : "bg-green-50 border border-green-200"
            )}
          >
            <p className="text-sm text-muted-foreground mb-1">
              {result.balance >= 0 ? "Amount to pay (Zahllast)" : "Amount to be refunded (Gutschrift)"}
            </p>
            <p
              className={cn(
                "text-2xl font-bold",
                result.balance >= 0 ? "text-amount-negative" : "text-amount-positive"
              )}
            >
              {formatAmount(Math.abs(result.balance))} EUR
            </p>
          </div>
        </CardContent>
      </Card>

      {result.unresolved.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Unresolved transactions ({result.unresolved.length})
            </CardTitle>
            <CardDescription>
              These claimed no input VAT (or defaulted to 20% output VAT). Finding the
              receipt moves the deduction into the figures — this is the chasing worklist.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {result.unresolved.map((u) => (
                <div key={u.transactionId} className="flex items-center gap-3 py-1.5 px-2 text-sm border-b last:border-b-0">
                  <span className="w-24 font-mono text-xs text-muted-foreground">{u.date}</span>
                  <span className="flex-1 truncate">{u.partner ?? "—"}</span>
                  <Badge variant="outline" className="text-xs">
                    {REASON_LABELS[u.reason] ?? u.reason}
                  </Badge>
                  <span className="w-28 text-right font-mono tabular-nums">
                    {formatAmount(u.amount)} EUR
                  </span>
                  <span className="w-32 text-right font-mono text-xs text-muted-foreground tabular-nums">
                    {u.side === "income"
                      ? `+${formatAmount(u.defaultedOutputVat ?? 0)} USt`
                      : u.foregoneVat != null
                        ? `${formatAmount(u.foregoneVat)} VSt lost`
                        : ""}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {result.nonClaimableVat.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Non-claimable VAT ({result.nonClaimableVat.length})
            </CardTitle>
            <CardDescription>
              These documents print a VAT figure that is not deductible Vorsteuer. The
              amount was excluded from KZ 060 on a recorded decision — it is not a
              missing receipt, and there is nothing to chase.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {result.nonClaimableVat.map((n) => (
                <div
                  key={`${n.transactionId}-${n.fileId}`}
                  className="flex items-center gap-3 py-1.5 px-2 text-sm border-b last:border-b-0"
                >
                  <span className="flex-1 truncate">
                    {NON_CLAIMABLE_LABELS[n.reason] ?? n.reason}
                  </span>
                  <Badge variant="outline" className="text-xs">
                    {n.reason}
                  </Badge>
                  <span className="w-32 text-right font-mono text-xs text-muted-foreground tabular-nums">
                    {formatAmount(n.excludedVat)} VSt excluded
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {result.reverseCharge.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Reverse charge (§19) — {result.reverseCharge.length} transactions
            </CardTitle>
            <CardDescription>
              Foreign B2B services: output VAT in KZ 057, same amount deducted in KZ 066.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {result.reverseCharge.map((rc) => (
                <div key={rc.transactionId} className="flex items-center gap-3 py-1.5 px-2 text-sm border-b last:border-b-0">
                  <span className="flex-1 font-mono text-xs truncate">{rc.transactionId}</span>
                  <Badge variant="outline" className="text-xs">{rc.origin}</Badge>
                  <Badge variant={rc.basis === "override" ? "default" : "secondary"} className="text-xs">
                    {rc.basis}
                  </Badge>
                  <span className="w-28 text-right font-mono tabular-nums">
                    {formatAmount(rc.base)} EUR
                  </span>
                  <span className="w-24 text-right font-mono text-xs text-muted-foreground tabular-nums">
                    {formatAmount(rc.vat)} VAT
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {result.foreignVat.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">
              Foreign VAT — excluded from this UVA ({result.foreignVat.length})
            </CardTitle>
            <CardDescription>
              Foreign VAT is never Austrian Vorsteuer; booked gross, tagged for the EU
              refund procedure where applicable.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {result.foreignVat.map((fv) => (
                <div key={`${fv.transactionId}-${fv.fileId ?? ""}`} className="flex items-center gap-3 py-1.5 px-2 text-sm border-b last:border-b-0">
                  <span className="flex-1 font-mono text-xs truncate">{fv.transactionId}</span>
                  <span className="font-mono text-xs">{fv.supplierVatId ?? "no UID"}</span>
                  {fv.rate != null && <Badge variant="outline" className="text-xs">{fv.rate}%</Badge>}
                  <span className="w-28 text-right font-mono tabular-nums">
                    {formatAmount(fv.amount)} EUR
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
