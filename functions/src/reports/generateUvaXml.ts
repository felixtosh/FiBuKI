/**
 * Cloud Function: Generate UVA XML for FinanzOnline
 *
 * Renders the per-Kennzahl figure record produced by the UVA calculation
 * module (functions/src/uva) into the BMF U30 XML envelope.
 *
 * QUARANTINE NOTE (spec §4, fork #64): no public XSD for the FinanzOnline
 * U30 upload exists, so the envelope element names below are unverified.
 * The authoritative deliverable is the per-KZ figure sheet entered
 * manually; this XML is best-effort until a schema is obtained. The KZ
 * codes themselves ARE verified against the official U30 form 2026 — the
 * renderer emits exactly the codes the calculation produced and invents
 * none (the old hand-mapping had 12 of 16 codes wrong, including a
 * 10%/13% swap and a fabricated KZ096).
 */

import { createCallable, HttpsError } from "../utils/createCallable";

export interface ReportPeriod {
  year: number;
  period: number;
  type: "monthly" | "quarterly";
}

/** Kennzahl code → value in cents, as produced by calculateUva. */
export type UvaKennzahlValues = Record<string, number>;

interface GenerateUvaXmlRequest {
  kennzahlen: UvaKennzahlValues;
  period: ReportPeriod;
  taxNumber: string; // FASTNR - 9 digits
}

interface GenerateUvaXmlResponse {
  success: boolean;
  xmlBase64: string;
  filename: string;
}

/**
 * Format amount for XML (cents to euros with 2 decimal places)
 * Returns empty string if amount is 0
 */
function formatAmount(cents: number): string {
  if (cents === 0) return "";
  const euros = cents / 100;
  return euros.toFixed(2);
}

/**
 * Get period date range strings in YYYY-MM format
 */
function getPeriodRange(period: ReportPeriod): { from: string; to: string } {
  const year = period.year;

  if (period.type === "monthly") {
    const month = period.period.toString().padStart(2, "0");
    return {
      from: `${year}-${month}`,
      to: `${year}-${month}`,
    };
  } else {
    // Quarterly
    const startMonth = ((period.period - 1) * 3 + 1).toString().padStart(2, "0");
    const endMonth = (period.period * 3).toString().padStart(2, "0");
    return {
      from: `${year}-${startMonth}`,
      to: `${year}-${endMonth}`,
    };
  }
}

/**
 * Generate UVA XML in FinanzOnline format from the per-KZ figure record.
 * Exported for use by submitUvaToFinanzOnline callable.
 */
export function generateUvaXml(
  kennzahlen: UvaKennzahlValues,
  period: ReportPeriod,
  taxNumber: string
): string {
  const now = new Date();
  const dateStr = now.toISOString().split("T")[0]; // YYYY-MM-DD
  const timeStr = now.toTimeString().split(" ")[0]; // HH:MM:SS
  const periodRange = getPeriodRange(period);

  // One element per Kennzahl the calculation emitted, in code order.
  // Zero values are omitted (the form leaves empty fields blank).
  let u30Content = "";
  for (const code of Object.keys(kennzahlen).sort()) {
    const value = formatAmount(kennzahlen[code]);
    if (!value) continue;
    u30Content += `      <KZ${code}>${value}</KZ${code}>\n`;
  }

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ERKLAERUNGS_UEBERMITTLUNG xmlns="http://www.bmf.gv.at/erklaerung/uebermittlung">
  <INFO_DATEN>
    <ART_IDENTIFIKATIONSBEGRIFF>FASTNR</ART_IDENTIFIKATIONSBEGRIFF>
    <IDENTIFIKATIONSBEGRIFF>${taxNumber}</IDENTIFIKATIONSBEGRIFF>
    <PAKET_NR>1</PAKET_NR>
    <DATUM_ERSTELLUNG>${dateStr}</DATUM_ERSTELLUNG>
    <UHRZEIT_ERSTELLUNG>${timeStr}</UHRZEIT_ERSTELLUNG>
    <ANZAHL_ERKLAERUNGEN>1</ANZAHL_ERKLAERUNGEN>
  </INFO_DATEN>
  <ERKLAERUNG>
    <SATZNR>1</SATZNR>
    <ALLGEMEINE_DATEN>
      <ANBRINGEN>U30</ANBRINGEN>
      <ZESSION>N</ZESSION>
      <FASESSION>N</FASESSION>
      <ZRVON>${periodRange.from}</ZRVON>
      <ZRBIS>${periodRange.to}</ZRBIS>
    </ALLGEMEINE_DATEN>
    <U30>
${u30Content}    </U30>
  </ERKLAERUNG>
</ERKLAERUNGS_UEBERMITTLUNG>`;

  return xml;
}

export const generateUvaXmlCallable = createCallable<
  GenerateUvaXmlRequest,
  GenerateUvaXmlResponse
>(
  { name: "generateUvaXml" },
  async (_ctx, request) => {
    const { kennzahlen, period, taxNumber } = request;

    // Validate tax number
    if (!taxNumber || !/^\d{9}$/.test(taxNumber)) {
      throw new HttpsError(
        "invalid-argument",
        "Tax number (FASTNR) must be exactly 9 digits"
      );
    }

    if (!kennzahlen || typeof kennzahlen !== "object") {
      throw new HttpsError("invalid-argument", "kennzahlen record is required");
    }

    if (!period) {
      throw new HttpsError("invalid-argument", "Period is required");
    }

    // Generate XML
    const xml = generateUvaXml(kennzahlen, period, taxNumber);

    // Generate filename
    const periodStr =
      period.type === "monthly"
        ? `${period.year}-${period.period.toString().padStart(2, "0")}`
        : `${period.year}-Q${period.period}`;
    const filename = `UVA_${periodStr}.xml`;

    return {
      success: true,
      xmlBase64: Buffer.from(xml, "utf-8").toString("base64"),
      filename,
    };
  }
);
